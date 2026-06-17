export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const boundary = req.headers['content-type'].split('boundary=')[1];

    // Parsear multipart manualmente
    const parts = buffer.toString('binary').split('--' + boundary);
    const docs = [];
    let count = 0;
    let modo = 'extraccion';

    for (const part of parts) {
      if (part.includes('name="count"')) {
        const match = part.match(/\r\n\r\n(\d+)/);
        if (match) count = parseInt(match[1]);
      }
      if (part.includes('name="modo"')) {
        const match = part.match(/\r\n\r\n(\w+)/);
        if (match) modo = match[1].trim();
      }
      if (part.includes('name="doc_')) {
        const jsonMatch = part.match(/\r\n\r\n({.*})/s);
        if (jsonMatch) {
          try {
            docs.push(JSON.parse(jsonMatch[1].trim()));
          } catch (e) {}
        }
      }
    }

    if (!docs.length) {
      return res.status(400).json({ error: 'No documents provided' });
    }

    // Validar tamaño total — Anthropic acepta hasta ~32MB por request en base64,
    // pero en Vercel free tier (10s timeout) documentos grandes provocan timeout antes de eso.
    // Límite conservador: 15MB de base64 combinado (~11MB de PDF real).
    const MAX_TOTAL_B64_CHARS = 15 * 1024 * 1024 * (4/3); // ~15MB de binario en base64
    const totalSize = docs.reduce((sum, d) => sum + (d.b64?.length || 0), 0);
    if (totalSize > MAX_TOTAL_B64_CHARS) {
      return res.status(413).json({
        error: 'Documentos demasiado grandes para procesar en una sola petición. Sube menos documentos o de menor tamaño (máx. ~11MB combinados).'
      });
    }
    if (docs.length > 4) {
      return res.status(413).json({
        error: 'Máximo 4 documentos por extracción para evitar timeout. Procesa el resto en otra tanda.'
      });
    }

    // Construir contenido para Claude
    const content = [];
    for (const doc of docs) {
      if (doc.mime === 'application/pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: doc.b64 }
        });
      } else {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: doc.mime, data: doc.b64 }
        });
      }
    }

    const PROMPT_EXTRACCION = `Eres un abogado experto en inversión NPL en España. Analiza estos documentos de una operación hipotecaria y extrae los datos para rellenar una ficha de inversión.

JERARQUÍA DE DOCUMENTOS — sigue este orden de prioridad estrictamente:
1. CUADRO DE AMORTIZACIÓN: es la fuente principal para "capital" e "intereses". Su resumen final ("Capital Impagado", "Intereses Ordinarios Impagados", "Total deuda") prevalece sobre cualquier otro documento.
2. ACTA DE FIJACIÓN DE SALDO: segunda fuente para capital e intereses si no hay cuadro.
3. NOTA SIMPLE REGISTRAL: fuente principal para "tasacion", "costas", "refCatastral", cargas y descripción del inmueble.
4. ESCRITURA DE CONSTITUCIÓN O CESIÓN: fuente para datos del inmueble, tipo de crédito y cláusulas. El importe original del préstamo que figura en la escritura NO es el capital pendiente — ignóralo para el campo "capital".

Responde ÚNICAMENTE con un objeto JSON con exactamente estas claves (usa null si no encuentras el dato):
{
  "capital": número (capital PENDIENTE e IMPAGADO en euros, sin céntimos — NO el importe original del préstamo; ver instrucciones específicas abajo para entender la diferencia),
  "intereses": número (suma TOTAL de la columna "Intereses" — también llamada "Intereses ordinarios" — de TODOS los recibos marcados como "Recibo impagado" del cuadro de amortización, en euros; NO sumes la columna "Demoras" ni "Gestión impago"; si el cuadro muestra un resumen final con la línea "Intereses Ordinarios Impagados: X€" usa ESE valor directamente sin sumar nada más),
  "costas": número (responsabilidad hipotecaria por costas y gastos que consta en la escritura o nota simple registral; búscala en el texto registral con literales como "Responsabilidad por costas", "costas y gastos", "gastos procesales"; si el inmueble es vivienda habitual del deudor aplica el límite del 5% sobre el capital pendiente — devuelve SIEMPRE el importe de escritura, el frontend aplicará el límite legal; null si no aparece),
  "fecha_acta": string (fecha del último recibo impagado del cuadro, o fecha de "VENCIMIENTO ANTICIPADO" si aparece, o fecha del acta de fijación de saldo; formato YYYY-MM-DD),
  "tasa_interes": null,
  "tasacion": número (valor de tasación para subasta pactado en escritura para caso de ejecución, art. 682 LEC, en euros; NO confundir con el valor de mercado),
  "mercado": número (valor de mercado estimado en euros, solo si aparece expresamente; null si no consta),
  "cargas_anteriores": número (importe de cargas anteriores a la hipoteca en euros),
  "refCatastral": string (referencia catastral, formato como 1234567AB1234A0001AB),
  "direccion": string (dirección completa del inmueble: calle, número, municipio, provincia),
  "metros": número (superficie en m²),
  "habitaciones": número (número de habitaciones),
  "banos": número (número de baños),
  "planta": string (planta del inmueble, ej: "3º", "bajo", "ático"),
  "tipo": "hipotecario_segunda" | "hipotecario_primera" | "ordinario",
  "tipo_inmueble": "piso" | "atico" | "bajo" | "bajo_jardin" | "local" | "chalet" | "solar",
  "fase": "prejudicial" | "monitorio" | "ejecucion_admitida" | "tasacion_hecha" | "subasta_senalada",
  "clausulas": "si" | "no_revisadas" | "pendiente",
  "vivienda_habitual_deudor": true | false | null (ver instrucciones específicas más abajo),
  "observaciones": string (máximo 150 palabras con hallazgos clave: cláusulas detectadas, estado del inmueble, deudor, riesgos jurídicos identificados)
}

Instrucciones específicas:
- La referencia catastral tiene formato alfanumérico de 20 caracteres. Búscala en la escritura o nota simple.
- Para "intereses": prioridad 1 — si el cuadro de amortización tiene un resumen final con la línea "Intereses Ordinarios Impagados: X€" o "Total deuda: X€" con desglose, usa directamente ese importe de intereses ordinarios. Prioridad 2 — si no hay resumen, suma SOLO la columna "Intereses" (no "Demoras", no "Gestión impago") de los recibos marcados como "Recibo impagado". Nunca mezcles intereses ordinarios con intereses de demora.
- Para "costas": búscala en la nota simple registral en el bloque HIPOTECA, texto literal como "Responsabilidad por costas y gastos: XXXX euros". En la escritura aparece en la cláusula de responsabilidad hipotecaria como un importe fijo. Devuelve siempre el importe de escritura/registro sin aplicar ningún límite (el sistema aplica: 5% del capital si vivienda habitual art. 575.1 bis LEC, 30% del capital si no es vivienda habitual art. 575.1 LEC).
- Para "fecha_acta": usa la fecha de la línea "VENCIMIENTO ANTICIPADO" del cuadro si existe; si no, la fecha del último recibo impagado; si no hay cuadro, la fecha del acta de fijación de saldo.
- DISTINCIÓN CRÍTICA para el campo "capital": existen DOS importes distintos que NO debes confundir:
  (a) CAPITAL ORIGINAL DEL PRÉSTAMO: el importe por el que se constituyó la hipoteca (ej. 178.760,53€). Aparece en la escritura de constitución o de cesión con frases como "formalizada por un importe de X euros". Este valor NO es el capital que debes extraer.
  (b) CAPITAL PENDIENTE IMPAGADO: el saldo vivo que queda por pagar a fecha de vencimiento anticipado. Este es el valor correcto para el campo "capital". Búscalo en este orden de prioridad:
     1. En el cuadro de amortización: línea "Capital Impagado: X€" en el resumen final.
     2. En el acta de fijación de saldo o certificado de deuda: "principal pendiente" o "capital reclamado".
     3. En la escritura de cesión: frase como "la deuda garantizada asciende a X€ por todos los conceptos" — en este caso el importe incluye intereses, así que ponlo en "capital" solo si no tienes desglose y déjalo indicado en observaciones.
  Si tienes el cuadro de amortización, el capital pendiente es SIEMPRE menor que el capital original.
- La tasación para subasta es el valor pactado en escritura para caso de ejecución (art. 682 LEC).
- Si el documento es una nota simple, extrae las cargas anteriores a la hipoteca objeto de estudio.
- Si hay cláusulas suelo, intereses de demora elevados o vencimiento anticipado agresivo, indícalo en observaciones y pon clausulas: "pendiente".
- Si la vivienda aparece como habitual del deudor, pon tipo: "hipotecario_primera".
- Para "vivienda_habitual_deudor": marca true si encuentras CUALQUIERA de estos dos indicios (no es necesario que coincidan ambos):
  (a) el documento declara expresamente que el inmueble es la "vivienda habitual" del deudor/hipotecante (p. ej. en la escritura, en la demanda de ejecución, o en cualquier otra resolución); o
  (b) el domicilio del deudor que consta para notificaciones (en la escritura, demanda o DNI si aparece) coincide con la dirección de la finca hipotecada.
  Marca false si el documento indica expresamente que NO es vivienda habitual (segunda residencia, inmueble vacío, arrendado a tercero, o domicilio del deudor distinto al de la finca).
  Marca null si no hay ningún indicio en ninguno de los dos sentidos.

No incluyas nada más que el JSON. Sin explicaciones, sin markdown, sin backticks.`;

    const PROMPT_RESOLUCION = `Eres un procurador/abogado experto en ejecuciones hipotecarias en España. Analiza esta resolución judicial (auto, decreto, diligencia de ordenación, providencia, notificación) y extrae la información clave para generar un recordatorio procesal.

Responde ÚNICAMENTE con un objeto JSON con exactamente estas claves (usa null si no encuentras el dato):
{
  "tipoResolucion": "auto" | "decreto" | "diligencia" | "providencia" | "notificacion" | "sentencia" | "otro",
  "organoJudicial": string (nombre completo del juzgado que dicta la resolución),
  "numeroProcedimiento": string (número de autos/procedimiento, ej: "123/2024"),
  "fechaResolucion": string (fecha de la resolución en formato YYYY-MM-DD),
  "fechaNotificacion": string (fecha de notificación si consta, formato YYYY-MM-DD, si no usar fechaResolucion),
  "resumenContenido": string (máximo 100 palabras resumiendo qué dice la resolución y por qué se dicta),
  "actuacionRequerida": string (qué debe hacer el procurador/abogado: personarse, contestar, recurrir, preparar pujas, nada, etc.),
  "plazoDias": número (días de plazo para actuar desde la notificación; null si no hay plazo o es informativa),
  "fechaLimite": string (fecha límite calculada sumando plazoDias a fechaNotificacion en días hábiles aproximados, formato YYYY-MM-DD; null si no aplica),
  "urgencia": "alta" | "media" | "baja" | "informativa",
  "faseDetectada": "prejudicial" | "monitorio" | "ejecucion_admitida" | "tasacion_hecha" | "subasta_senalada" (la fase procesal que se infiere tras esta resolución),
  "fechaSubasta": string (si la resolución señala fecha de subasta, formato YYYY-MM-DD; null si no aplica)
}

Instrucciones específicas:
- Si es un Auto de Admisión a Trámite / Despacho de Ejecución: actuacionRequerida = "Personarse en el procedimiento", plazoDias = 10, urgencia = "alta".
- Si es un Decreto de Convocatoria de Subasta: actuacionRequerida = "Preparar documentación para pujas, verificar cargas posteriores", urgencia = "alta", extraer fechaSubasta si consta.
- Si es una notificación de Oposición del deudor: actuacionRequerida = "Revisar motivos de oposición y preparar contestación/impugnación", plazoDias = 5, urgencia = "alta".
- Si es un Requerimiento de pago al deudor: actuacionRequerida = "Monitorizar plazo de pago del deudor", plazoDias = 10, urgencia = "media".
- Si es una Certificación de cargas o Diligencia de ordenación puramente informativa sin plazo de respuesta: urgencia = "informativa", actuacionRequerida = "Sin actuación requerida — informativo".
- Si detectas alegación de cláusulas abusivas por el deudor: menciónalo expresamente en resumenContenido.
- Las fechas límite deben calcularse en días hábiles aproximados (excluyendo sábados, domingos y agosto si el plazo cae total o parcialmente en ese mes).

No incluyas nada más que el JSON. Sin explicaciones, sin markdown, sin backticks.`;

    content.push({
      type: 'text',
      text: modo === 'resolucion' ? PROMPT_RESOLUCION : PROMPT_EXTRACCION
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'Error calling Anthropic API' });
    }

    const data = await response.json();
    const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse error:', clean);
      return res.status(500).json({ error: 'Error parsing AI response' });
    }

    return res.status(200).json(parsed);

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message });
  }
}
