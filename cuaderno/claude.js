// Cliente mínimo de la API de Claude para navegador (sin dependencias).
import { loadSettings } from './db.js';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2026-10-21';

function headers(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    // Si los filtros de seguridad declinan, la API reintenta con otro modelo en la misma llamada.
    'anthropic-beta': 'server-side-fallback-2026-07-01',
  };
}

export class ClaudeError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function hasKey() { return !!loadSettings().apiKey; }

/**
 * Llama a Claude en streaming. onDelta recibe cada fragmento de texto.
 * Devuelve el texto completo. Lanza ClaudeError si falla o si hay rechazo.
 */
export async function ask({ system, messages, maxTokens = 8000, effort, onDelta, signal, model }) {
  const settings = loadSettings();
  if (!settings.apiKey) throw new ClaudeError('Añade tu clave de API de Anthropic en Ajustes.', 0);
  const body = {
    model: model || settings.model || 'claude-fable-5-1',
    max_tokens: maxTokens,
    stream: true,
    fallbacks: 'default',
    messages,
  };
  if (system) body.system = system;
  if (effort) body.output_config = { effort };

  let res;
  try {
    res = await fetch(API, { method: 'POST', headers: headers(settings.apiKey), body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ClaudeError('Sin conexión con la API de Claude.', 0);
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    if (res.status === 401) msg = 'Clave de API no válida. Revísala en Ajustes.';
    if (res.status === 429) msg = 'Límite de uso alcanzado. Espera un momento.';
    throw new ClaudeError(msg, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = null;
  let refusal = null;

  const handle = (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      text += evt.delta.text;
      onDelta && onDelta(evt.delta.text, text);
    } else if (evt.type === 'message_delta') {
      stopReason = evt.delta?.stop_reason || stopReason;
      if (evt.delta?.stop_details?.type === 'refusal') refusal = evt.delta.stop_details;
    } else if (evt.type === 'error') {
      throw new ClaudeError(evt.error?.message || 'Error de la API', 500);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      handle(evt);
    }
  }
  if (stopReason === 'refusal') {
    throw new ClaudeError('Claude ha declinado esta petición' + (refusal?.explanation ? ': ' + refusal.explanation : '.'), 200);
  }
  if (stopReason === 'max_tokens') text += '\n\n[respuesta recortada por longitud]';
  return text;
}

/** Transcribe una imagen PNG (base64 sin prefijo) de texto manuscrito. */
export async function handwritingToText(pngBase64, { lang = 'es', signal, onDelta } = {}) {
  const system = `Eres un transcriptor experto de notas manuscritas. Recibes la imagen de una página escrita a mano con Apple Pencil.
Devuelve únicamente la transcripción fiel del texto, en el idioma original (probablemente ${lang === 'es' ? 'español' : lang}), respetando saltos de línea, listas y títulos cuando sean evidentes.
Usa Markdown ligero solo si ayuda (guiones para listas, # para títulos). No comentes nada, no añadas introducciones ni explicaciones.
Si una palabra es ilegible escribe [?]. Si la página no contiene texto, responde exactamente: (sin texto)`;
  return ask({
    system,
    effort: 'low',
    maxTokens: 4000,
    signal,
    onDelta,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
        { type: 'text', text: 'Transcribe esta página.' },
      ],
    }],
  });
}

const SECRETARY_TASKS = {
  resumen: 'Escribe un resumen ejecutivo de la reunión hasta ahora: contexto, temas tratados y conclusiones. Máximo 200 palabras, en párrafos claros.',
  acta: 'Redacta el acta formal de la reunión: título, fecha, asistentes (si se mencionan), orden del día deducido, desarrollo por puntos, acuerdos y próximos pasos. Formato Markdown con encabezados.',
  puntos: 'Extrae los puntos clave de la reunión como una lista de viñetas breves (máximo 12). Sin introducción.',
  acciones: 'Lista las tareas y compromisos que se han acordado, con responsable (si se menciona) y plazo (si se menciona), como lista de verificación "- [ ] ...". Si no hay ninguna clara, dilo en una línea.',
  decisiones: 'Enumera las decisiones tomadas en la reunión, una por viñeta, con la justificación si se dio. Si no hay decisiones claras, dilo en una línea.',
  preguntas: 'Enumera las preguntas abiertas, dudas y temas pendientes que han quedado sin cerrar. Sugiere para cada una quién debería resolverla si se deduce del contexto.',
  correo: 'Redacta un correo breve de seguimiento para los asistentes, con tono profesional y cercano, que resuma lo acordado y los próximos pasos. Incluye asunto.',
};
export const SECRETARY_LABELS = {
  resumen: 'Resumen', acta: 'Acta', puntos: 'Puntos clave', acciones: 'Acciones', decisiones: 'Decisiones', preguntas: 'Pendientes', correo: 'Correo de seguimiento',
};

function secretarySystem(ctx) {
  const s = loadSettings();
  return `Eres el secretario personal del usuario durante sus reuniones. Trabajas en español salvo que la transcripción esté claramente en otro idioma.
${s.persona ? 'Sobre el usuario: ' + s.persona + '\n' : ''}
Recibes la transcripción en vivo de una reunión (puede tener errores de reconocimiento de voz: corrige nombres y palabras por contexto sin inventar) y, a veces, notas que el usuario escribe a mano durante la sesión (marcadas como [nota]). Las notas del usuario tienen prioridad sobre la transcripción.
${ctx.title ? 'Reunión: ' + ctx.title + '\n' : ''}${ctx.when ? 'Fecha: ' + ctx.when + '\n' : ''}${ctx.attendees ? 'Asistentes previstos: ' + ctx.attendees + '\n' : ''}${ctx.description ? 'Descripción de la convocatoria: ' + ctx.description + '\n' : ''}
Sé preciso, sobrio y útil. No inventes acuerdos que no aparezcan. Usa Markdown.`;
}

/** Pide al secretario una tarea predefinida o una pregunta libre sobre la transcripción. */
export async function secretary({ task, question, transcript, notes, ctx = {}, onDelta, signal, history = [] }) {
  const instruction = task ? SECRETARY_TASKS[task] : question;
  const corpus = transcript.trim() ? transcript : '(todavía no hay transcripción)';
  const notesBlock = notes && notes.trim() ? `\n\nNotas manuscritas del usuario:\n${notes}` : '';
  const messages = [
    ...history,
    { role: 'user', content: `Transcripción de la reunión (${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}):\n"""\n${corpus}\n"""${notesBlock}\n\nTarea: ${instruction}` },
  ];
  return ask({ system: secretarySystem(ctx), messages, maxTokens: 6000, onDelta, signal });
}

/** Resumen/ayuda sobre una nota de texto (pregunta libre). */
export async function askAboutNote({ title, text, question, onDelta, signal }) {
  const s = loadSettings();
  return ask({
    system: `Eres un asistente de notas sobrio y preciso. ${s.persona ? 'Sobre el usuario: ' + s.persona : ''} Responde en el idioma de la nota. Usa Markdown.`,
    messages: [{ role: 'user', content: `Nota "${title || 'Sin título'}":\n"""\n${text}\n"""\n\n${question}` }],
    maxTokens: 6000, onDelta, signal,
  });
}
