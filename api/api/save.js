// /api/save.js — Guarda toda la plataforma en Airtable.
// Recibe el MISMO objeto JSON que produce exportarTodo:
//   { inversiones, estudios, gastos, juzgados, resoluciones, tareas, seguimiento }
// Estrategia segura por tabla: crea los registros nuevos y DESPUÉS borra los
// antiguos (así nunca hay un instante con la tabla vacía si algo falla).
//
// Variables de entorno necesarias en Vercel:
//   AIRTABLE_TOKEN     -> Personal Access Token de Airtable (obligatorio)
//   AIRTABLE_BASE_ID   -> opcional; por defecto la base "NPL Invest"

const BASE = process.env.AIRTABLE_BASE_ID || 'appin37BVEKhrqek2';
const TOKEN = process.env.AIRTABLE_TOKEN;

async function at(path, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Airtable ${r.status}: ${t}`);
  }
  return r.json();
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const num = v => {
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
};

// Quita null / undefined / '' para no mandar campos vacíos a Airtable.
function clean(f) {
  const o = {};
  for (const k in f) {
    const v = f[k];
    if (v === null || v === undefined || v === '') continue;
    o[k] = v;
  }
  return o;
}

async function listRecordIds(table) {
  let ids = [];
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (offset) params.set('offset', offset);
    const data = await at(`${encodeURIComponent(table)}?${params.toString()}`, { method: 'GET' });
    ids = ids.concat((data.records || []).map(r => r.id));
    offset = data.offset;
  } while (offset);
  return ids;
}

async function replaceTable(table, recordsFields) {
  const oldIds = await listRecordIds(table);
  // 1) crear los nuevos
  for (const batch of chunk(recordsFields, 10)) {
    if (!batch.length) continue;
    await at(encodeURIComponent(table), {
      method: 'POST',
      body: JSON.stringify({ records: batch.map(f => ({ fields: f })), typecast: true })
    });
  }
  // 2) borrar los antiguos
  for (const batch of chunk(oldIds, 10)) {
    if (!batch.length) continue;
    const qs = batch.map(id => `records[]=${encodeURIComponent(id)}`).join('&');
    await at(`${encodeURIComponent(table)}?${qs}`, { method: 'DELETE' });
  }
}

// ── Mapeos web -> Airtable (solo campos que existen en la base) ──────────────
function opFields(o, tipoOpDefault) {
  const vh = o.viviendaHabitualDeudor === true ? 'si'
    : o.viviendaHabitualDeudor === false ? 'no' : null;
  return clean({
    ref: o.ref, id: o.id, tipoOp: o.tipoOp || tipoOpDefault,
    finalizada: !!o.finalizada,
    tipo: o.tipo, estrategia: o.estrategia,
    capital: num(o.capital), intereses: num(o.intereses), interesesHoy: num(o.interesesHoy),
    costas: num(o.costas), fechaActa: o.fechaActa, fecha_pago: o.fecha_pago,
    fase: o.fase, clausulas: o.clausulas, vulnerabilidad: o.vulnerabilidad, epi: o.epi,
    juzgado: o.juzgado, precio: num(o.precio), tasacion: num(o.tasacion), mercado: num(o.mercado),
    cargas: num(o.cargas), capex: num(o.capex), meses: num(o.meses),
    liquidez: o.liquidez, ocupacion: o.ocupacion, viviendaHabitualDeudor: vh,
    obs: o.obs, direccion: o.direccion, refCatastral: o.refCatastral, tipo_inmueble: o.tipo_inmueble,
    metros: num(o.metros), habitaciones: num(o.habitaciones), banos: num(o.banos), planta: o.planta,
    fecha: o.fecha, score: num(o.score), ai_dictamen: o.ai_dictamen,
    cantidadObtenida: num(o.cantidadObtenida), tipoCobro: o.tipoCobro, fechaCierre: o.fechaCierre
  });
}
const gFields = g => clean({
  id: g.id, opRef: g.opRef, categoria: g.categoria, nombre: g.nombre,
  importe: num(g.importe), fecha: g.fecha, factura_nombre: g.factura_nombre
});
const rFields = r => clean({
  id: r.id, opRef: r.opRef, tipoResolucion: r.tipoResolucion, organoJudicial: r.organoJudicial,
  numeroProcedimiento: r.numeroProcedimiento, fechaResolucion: r.fechaResolucion,
  fechaNotificacion: r.fechaNotificacion, resumenContenido: r.resumenContenido,
  actuacionRequerida: r.actuacionRequerida, plazoDias: num(r.plazoDias), fechaLimite: r.fechaLimite,
  urgencia: r.urgencia, faseDetectada: r.faseDetectada, fechaSubasta: r.fechaSubasta,
  docNombre: r.docNombre, fechaSubida: r.fechaSubida
});
const tFields = t => clean({
  id: t.id, opRef: t.opRef, descripcion: t.descripcion, fechaLimite: t.fechaLimite,
  urgencia: t.urgencia, origenResolucion: t.origenResolucion, completada: !!t.completada, creada: t.creada
});
const sFields = s => clean({
  id: s.id, opRef: s.opRef, estado: s.estado, fecha: s.fecha, nota: s.nota
});
function juzgadosToRows(obj) {
  return Object.entries(obj || {}).map(([juzgado, v]) => clean({
    juzgado, admision: num(v.admision), subasta: num(v.subasta), total: num(v.total), notas: v.notas
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!TOKEN) {
    return res.status(500).json({ error: 'Falta la variable de entorno AIRTABLE_TOKEN' });
  }
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object') body = {};

    const operaciones = [
      ...((body.inversiones || []).map(o => opFields(o, 'inversion'))),
      ...((body.estudios || []).map(o => opFields(o, 'estudio')))
    ];
    await replaceTable('Operaciones', operaciones);
    if (body.gastos) await replaceTable('Gastos', body.gastos.map(gFields));
    if (body.resoluciones) await replaceTable('Resoluciones', body.resoluciones.map(rFields));
    if (body.tareas) await replaceTable('Tareas', body.tareas.map(tFields));
    if (body.seguimiento) await replaceTable('Seguimiento', body.seguimiento.map(sFields));
    if (body.juzgados) await replaceTable('Juzgados', juzgadosToRows(body.juzgados));

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('save.js error:', e);
    return res.status(500).json({ error: e.message });
  }
}
