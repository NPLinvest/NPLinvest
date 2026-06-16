export const config = { 
  api: { bodyParser: false },
  maxDuration: 60
};

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

    for (const part of parts) {
      if (part.includes('name="count"')) {
        const match = part.match(/\r\n\r\n(\d+)/);
        if (match) count = parseInt(match[1]);
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

    content.push({
      type: 'text',
      text: `Eres un abogado experto en inversión NPL en España. Analiza estos documentos de una operación hipotecaria y extrae los datos para rellenar una ficha de inversión.

Responde ÚNICAMENTE con un objeto JSON con exactamente estas claves (usa null si no encuentras el dato):
{
  "capital": número (capital principal pendiente en euros, sin céntimos),
  "intereses": número (intereses ordinarios devengados en euros),
  "tasacion": número (valor de tasación para subasta en euros),
  "mercado": número (valor de mercado estimado en euros, si aparece),
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
  "observaciones": string (máximo 150 palabras con hallazgos clave: cláusulas detectadas, estado del inmueble, deudor, riesgos jurídicos identificados)
}

Instrucciones específicas:
- La referencia catastral tiene formato alfanumérico de 20 caracteres. Búscala en la escritura o nota simple.
- El capital principal es la responsabilidad hipotecaria por principal, NO el total con intereses y costas.
- La tasación para subasta es el valor pactado en escritura para caso de ejecución (art. 682 LEC).
- Si el documento es una nota simple, extrae las cargas anteriores a la hipoteca objeto de estudio.
- Si hay cláusulas suelo, intereses de demora elevados o vencimiento anticipado agresivo, indícalo en observaciones y pon clausulas: "pendiente".
- Si la vivienda aparece como habitual del deudor, pon tipo: "hipotecario_primera".

No incluyas nada más que el JSON. Sin explicaciones, sin markdown, sin backticks.`
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
