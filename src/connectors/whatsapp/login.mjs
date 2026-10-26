import qrcode from 'qrcode-terminal';
import { rm } from 'node:fs/promises';
import { WorkflowError } from '../../artifact/errors.mjs';
import { authAvailable, authDir as resolveAuthDir, ensureAuthDir, harden } from './auth.mjs';
import { createWhatsAppRunner } from './runner.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function login({ authDir, timeout = '300' }, env = process.env) {
  const dir = resolveAuthDir(env, authDir);
  const seconds = Number.parseInt(timeout, 10);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw new WorkflowError('INVALID_INPUT', 400, { detail: 'timeout must be 30..3600 seconds' });
  await ensureAuthDir(dir);

  let qrShown = 0;
  const runner = createWhatsAppRunner({
    authDir: dir,
    pair: true,
    onQr: qr => {
      qrShown++;
      process.stderr.write('WhatsApp > Dispositivos vinculados > Vincular un dispositivo. El QR se renueva solo.\n');
      qrcode.generate(qr, { small: true }, output => process.stderr.write(`${output}\n`));
    },
  });

  try {
    await runner.start();
    const deadline = Date.now() + seconds * 1000;
    let connectedAt = null;
    let lastTotal = -1;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const { data } = await runner.run('whatsapp_status', {});
      if (data.state === 'logged_out') throw new WorkflowError('REAUTH_REQUIRED', 401);
      if (data.state === 'error') throw new WorkflowError('PAIRING_FAILED', 502, { detail: data.last_error });
      if (data.state === 'connected' && !connectedAt) {
        connectedAt = Date.now();
        process.stderr.write(`Dispositivo vinculado. Credenciales en ${dir}\nEsperando la sincronización inicial de chats...\n`);
      }
      const total = data.chat_count + data.message_count;
      if (connectedAt && total > 0) {
        if (total !== lastTotal) { lastTotal = total; lastChange = Date.now(); }
        else if (Date.now() - lastChange > 30_000) break;
      }
      if (connectedAt && Date.now() - connectedAt > 180_000) break;
      await delay(1000);
    }
    if (!connectedAt) throw new WorkflowError('PAIRING_TIMEOUT', 504, { qr_shown: qrShown > 0 });
    const { data } = await runner.run('whatsapp_status', {});
    return { auth_dir: dir, ...data };
  } finally {
    await runner.close();
    await harden(dir).catch(() => {});
  }
}

export async function status({ authDir }, env = process.env) {
  const dir = resolveAuthDir(env, authDir);
  const runner = createWhatsAppRunner({ authDir: dir });
  try {
    await runner.start();
    const { data } = await runner.run('whatsapp_status', {});
    return { auth_dir: dir, auth: authAvailable(dir), ...data };
  } finally {
    await runner.close();
  }
}

export async function logout({ authDir, yes }, env = process.env) {
  const dir = resolveAuthDir(env, authDir);
  if (!yes) throw new WorkflowError('CONFIRMATION_REQUIRED', 409, { auth_dir: dir });
  if (!authAvailable(dir)) {
    await rm(dir, { recursive: true, force: true });
    return { auth_dir: dir, cleared: false };
  }
  const runner = createWhatsAppRunner({ authDir: dir });
  let unlinked = false;
  let detail = null;
  try {
    unlinked = await runner.unlink();
  } catch (error) {
    detail = error.message;
  } finally {
    await runner.close();
    await rm(dir, { recursive: true, force: true });
  }
  return { auth_dir: dir, cleared: true, unlinked, ...(detail ? { detail } : {}) };
}
