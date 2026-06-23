// /api/data.js — Lee toda la plataforma desde Airtable y la devuelve en el
// MISMO formato que usa la web (exportarTodo / importarTodo).
// La web llama a este endpoint al cargar para hidratar su almacenamiento.
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

// Lee TODOS los registros de una tabla (paginando) y devuelve solo sus fields.
async function listAll(table) {
  let out = [];
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (offset) params.set('offset', offset);
    const data = await at(`${encodeURIComponent(table)}?${params.toString()}`, { method: 'GET' });
    out = out.concat((data.records || []).map(r => r.fields || {}));
    offset = data.offset;
  } while (offset);
  return out;
}

// Convierte una operación de Airtable al objeto que espera la web.
function mapOp(f) {
  const o = { ...f };
  o.finalizada = !!f.finalizada;
  if (f.viviendaHabitualDeudor === 'si') o.viviendaHabitualDeudor = true;
  else if (f.viviendaHabitualDeudor === 'no') o.viviendaHabitualDeudor = false;
  else o.viviendaHabitualDeudor = null;
  return o;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!TOKEN) {
    return res.status(500).json({ error: 'Falta la variable de entorno AIRTABLE_TOKEN' });
  }
  try {
    const opsRaw = await listAll('Operaciones');
    const ops = opsRaw.map(mapOp);
    const inversiones = ops.filter(o => (o.tipoOp || 'inversion') === 'inversion');
    const estudios = ops.filter(o => o.tipoOp === 'estudio');

    const gastos = await listAll('Gastos');
    const resoluciones = await listAll('Resoluciones');
    const tareas = (await listAll('Tareas')).map(t => ({ ...t, completada: !!t.completada }));
    const seguimiento = await listAll('Seguimiento');

    const juzRows = await listAll('Juzgados');
    const juzgados = {};
    juzRows.forEach(j => {
      if (!j.juzgado) return;
      juzgados[j.juzgado] = {
        admision: j.admision ?? null,
        subasta: j.subasta ?? null,
        total: j.total ?? null,
        notas: j.notas || ''
      };
    });

    return res.status(200).json({
      version: 1,
      fechaExportacion: new Date().toISOString(),
      inversiones,
      estudios,
      gastos,
      juzgados,
      resoluciones,
      tareas,
      seguimiento
    });
  } catch (e) {
    console.error('data.js error:', e);
    return res.status(500).json({ error: e.message });
  }
}
