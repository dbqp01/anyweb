import { z } from 'zod';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { WorkflowError } from '../../artifact/errors.mjs';
import { authAvailable, harden, storeFile } from './auth.mjs';
import { createStore } from './store.mjs';

const noop = () => {};
const silentLogger = { level: 'silent', child: () => silentLogger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };

export const limits = [
  'Read-only bridge to the user\'s own paired WhatsApp account; it never sends messages or presence updates and does not request read receipts.',
  'Unofficial multi-device client: use is at the user\'s risk and may violate WhatsApp Terms; account restriction is possible.',
  'In-memory snapshot from the recent history sync and live events; it is not a complete archive and resets on restart.',
  'Media is not downloaded; only type, caption/text and timestamps are exposed.',
  'Edits and deletions are not merged into the stored message; reactions are stored as their own messages.',
  'The protocol may still emit automatic delivery acknowledgements; this app does not send read receipts.',
];

const limit = z.number().int().min(1).max(200).default(50);

export const whatsappInputs = {
  whatsapp_status: z.object({}).strict(),
  whatsapp_list_chats: z.object({ limit }).strict(),
  whatsapp_get_messages: z.object({ chat_id: z.string().min(1).max(200), limit }).strict(),
  whatsapp_search_messages: z.object({ query: z.string().trim().min(1).max(200), chat_id: z.string().min(1).max(200).optional(), limit }).strict(),
};

export const whatsappDefinitions = {
  whatsapp_status: { description: 'Estado de la vinculación de WhatsApp y tamaño de la instantánea en memoria (chats y mensajes). Solo lectura.' },
  whatsapp_list_chats: { description: 'Lista chats de WhatsApp ordenados por actividad reciente: nombre, grupo, no leídos, último mensaje. Solo lectura.' },
  whatsapp_get_messages: { description: 'Devuelve los mensajes más recientes de un chat en orden cronológico. No descarga multimedia ni envía mensajes.' },
  whatsapp_search_messages: { description: 'Busca texto (sin distinguir mayúsculas) en los mensajes sincronizados, opcionalmente dentro de un chat. Solo lectura.' },
};

const socketOptions = auth => ({
  auth,
  logger: silentLogger,
  printQRInTerminal: false,
  markOnlineOnConnect: false,
  syncFullHistory: false,
  shouldSyncHistoryMessage: () => true,
  emitOwnEvents: false,
  browser: Browsers.ubuntu('Chrome'),
});

export function createWhatsAppRunner({ authDir, pair = false, onQr } = {}) {
  const store = createStore();
  const storePath = storeFile(authDir);
  let socket = null;
  let state = authAvailable(authDir) ? 'connecting' : 'awaiting_pairing';
  let selfJid = null;
  let historySynced = false;
  let lastError = null;
  let reconnectTimer = null;
  let saveTimer = null;
  let dirty = false;
  let loaded = false;
  let started = false;
  let closed = false;
  let attempts = 0;

  const setState = (next, error = null) => {
    state = next;
    lastError = error ? String(error).slice(0, 200) : null;
  };

  const save = async () => {
    if (!dirty) return;
    dirty = false;
    try {
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(`${storePath}.tmp`, JSON.stringify(store.toJSON()), { mode: 0o600 });
      await rename(`${storePath}.tmp`, storePath);
    } catch {
      dirty = true;
    }
  };

  const scheduleSave = () => {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1000);
    saveTimer.unref?.();
  };

  const schedule = milliseconds => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, milliseconds);
    reconnectTimer.unref?.();
  };

  async function connect() {
    if (closed) return;
    try {
      const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
      const sock = makeWASocket(socketOptions(auth));
      socket = sock;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', update => {
        if (socket !== sock) return;
        if (update.qr && onQr) onQr(update.qr);
        if (update.connection === 'open') {
          attempts = 0;
          selfJid = sock.user?.id ?? null;
          setState('connected');
        } else if (update.connection === 'close') {
          if (closed) return;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          const reason = update.lastDisconnect?.error?.message;
          socket = null;
          if (code === DisconnectReason.loggedOut) {
            setState('logged_out', reason);
            return;
          }
          setState('connecting', reason);
          attempts++;
          schedule(code === DisconnectReason.restartRequired ? 0 : Math.min(1000 * 2 ** attempts, 30_000));
        }
      });
      sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
        store.upsertContacts(contacts);
        store.upsertChats(chats);
        store.addMessages(messages);
        if (isLatest) historySynced = true;
        scheduleSave();
      });
      sock.ev.on('chats.upsert', list => { store.upsertChats(list); scheduleSave(); });
      sock.ev.on('chats.update', list => { store.upsertChats(list); scheduleSave(); });
      sock.ev.on('contacts.upsert', list => { store.upsertContacts(list); scheduleSave(); });
      sock.ev.on('contacts.update', list => { store.upsertContacts(list); scheduleSave(); });
      sock.ev.on('messages.upsert', ({ messages }) => { store.addMessages(messages); scheduleSave(); });
    } catch (error) {
      socket = null;
      setState('error', error?.message);
      attempts++;
      schedule(Math.min(1000 * 2 ** attempts, 30_000));
    }
  }

  return {
    authDir,
    async start() {
      if (started) return;
      started = true;
      if (!authAvailable(authDir) && !pair) {
        setState('awaiting_pairing');
        return;
      }
      if (!loaded) {
        loaded = true;
        try {
          store.hydrate(JSON.parse(await readFile(storePath, 'utf8')));
          historySynced = store.counts().message_count > 0;
        } catch {}
      }
      await connect();
      const deadline = Date.now() + 10_000;
      while (!closed && state === 'connecting' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    },
    async close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (saveTimer) clearTimeout(saveTimer);
      reconnectTimer = null;
      saveTimer = null;
      await save();
      try { socket?.end(undefined); } catch {}
      socket = null;
      await harden(authDir).catch(() => {});
    },
    // Unlinks the paired device, then the caller may delete the local auth directory.
    async unlink({ timeout = 30_000 } = {}) {
      if (!authAvailable(authDir)) return false;
      const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
      const sock = makeWASocket(socketOptions(auth));
      sock.ev.on('creds.update', saveCreds);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), timeout);
          sock.ev.on('connection.update', update => {
            if (update.connection === 'open') {
              clearTimeout(timer);
              Promise.resolve(sock.logout()).then(resolve, reject);
            } else if (update.connection === 'close') {
              clearTimeout(timer);
              reject(new Error(`connection closed (${update.lastDisconnect?.error?.output?.statusCode ?? 'unknown'})`));
            }
          });
        });
        return true;
      } finally {
        try { sock.end(undefined); } catch {}
      }
    },
    async run(tool, input) {
      const counts = store.counts();
      const current = {
        state,
        connected: state === 'connected',
        self_jid: selfJid,
        history_synced: historySynced,
        ...counts,
        last_error: lastError,
      };
      const stamp = {
        source_mode: 'observed_first_party_protocol',
        scope: 'whatsapp_personal_read_only',
        transport: 'whatsapp_multidevice_websocket',
        session: 'user_paired_device',
        observed_at: new Date().toISOString(),
        connected: state === 'connected',
        history_synced: historySynced,
        limits,
      };
      if (tool === 'whatsapp_status') return { data: current, evidence: stamp };
      if (state === 'awaiting_pairing') throw new WorkflowError('SESSION_NOT_CONFIGURED', 401);
      if (state === 'logged_out') throw new WorkflowError('REAUTH_REQUIRED', 401);
      if (state !== 'connected') throw new WorkflowError('SESSION_NOT_READY', 503);
      if (tool === 'whatsapp_list_chats') return { data: store.listChats(input.limit), evidence: stamp };
      if (tool === 'whatsapp_get_messages') return { data: { chat_id: input.chat_id, ...store.messagesFor(input.chat_id, input.limit) }, evidence: stamp };
      if (tool === 'whatsapp_search_messages') return { data: store.search(input.query, input.chat_id, input.limit), evidence: stamp };
      throw new WorkflowError('UNSUPPORTED_OPERATION');
    },
  };
}
