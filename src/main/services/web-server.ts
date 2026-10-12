import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { SettingsService } from './SettingsService';
import { BackupService } from './BackupService';
import { dispatchWebRequest, IPC_CHANNELS } from './ipc';
import type { AppDatabase } from '../db/connection';
import type { Database as Schema } from '../db/schema-types';

interface WebUser {
  id: number;
  username: string;
  role: 'admin' | 'staff';
}

interface Session extends WebUser {
  expiresAt: number;
}

export interface WebServerOptions {
  userDataPath?: string;
  webRoot?: string;
}

const SESSION_COOKIE = 'school_fees_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PASSWORD_BYTES = 64;
const sessions = new Map<string, Session>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const ADMIN_ONLY_CHANNELS = new Set([
  'settings:pickLogo',
  'backup:createNow',
  'backup:restore',
  'classLevels:create',
  'classLevels:update',
  'classLevels:upsertStructured',
  'classLevels:removeSectionClass',
  'classFees:upsert',
  'paymentCategories:create',
  'paymentCategories:update',
  'paymentCategories:delete',
  'cashiers:create',
  'cashiers:update',
  'cashiers:delete',
  'schoolYears:closeout',
  'expenseCategories:create',
  'expenseCategories:update',
  'expenseCategories:delete',
  'dataCleanup:preview',
  'dataCleanup:clear',
  'dataCleanup:loadFixtures',
  'students:delete',
  'enrollments:delete',
  'payments:delete',
  'expenses:delete',
  'staff:delete',
  'staff:deletePayment',
  'system:getLogTail',
]);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function passwordHash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64, { maxmem: 64 * 1024 * 1024 });
}

function validateCredentials(username: string, password: string): string {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(normalized)) {
    throw new Error(
      'Le nom d’utilisateur doit contenir 3 à 40 caractères valides.',
    );
  }
  if (
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > PASSWORD_BYTES
  ) {
    throw new Error(
      'Le mot de passe doit contenir au moins 8 caractères et au maximum 64 octets.',
    );
  }
  return normalized;
}

async function createUser(
  db: Kysely<Schema>,
  username: string,
  password: string,
  role: 'admin' | 'staff',
): Promise<WebUser> {
  const normalized = validateCredentials(username, password);

  const salt = randomBytes(16).toString('hex');
  const digest = passwordHash(password, salt);
  const result = await db
    .insertInto('web_users')
    .values({
      username: normalized,
      password_hash: digest.toString('hex'),
      password_salt: salt,
      role,
      disabled: 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { id: Number(result.id), username: normalized, role };
}

function userFromRow(row: Record<string, unknown>): WebUser {
  return {
    id: Number(row.id),
    username: String(row.username),
    role: row.role === 'admin' ? 'admin' : 'staff',
  };
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY_BYTES)
      throw new Error('La requête dépasse la taille autorisée.');
    chunks.push(data);
  }
  const body: unknown = JSON.parse(
    Buffer.concat(chunks).toString('utf8') || '{}',
  );
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Le corps de la requête doit être un objet JSON.');
  }
  return body as Record<string, unknown>;
}

async function readBinary(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 512 * 1024 * 1024)
      throw new Error('La sauvegarde dépasse 512 Mo.');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function getCookie(request: IncomingMessage, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

function cookieValue(token: string | null, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${token ? Math.floor(SESSION_TTL_MS / 1000) : 0}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function getSession(request: IncomingMessage): Session | null {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const key = hashToken(token);
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(key);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    const normalizeHost = (value: string) =>
      value.toLowerCase().replace(/^\[|\]$/g, '');
    const requestHost = normalizeHost(new URL(`http://${host}`).hostname);
    const originHost = normalizeHost(originUrl.hostname);
    const allowedHosts = new Set(
      (process.env.WEB_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,::1')
        .split(',')
        .map((value) => normalizeHost(value.trim()))
        .filter(Boolean),
    );
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
      allowedHosts.add(normalizeHost(process.env.RENDER_EXTERNAL_HOSTNAME));
    }
    if (
      process.env.WEB_HOST &&
      !['0.0.0.0', '::'].includes(process.env.WEB_HOST)
    ) {
      allowedHosts.add(normalizeHost(process.env.WEB_HOST));
    }
    return (
      originUrl.host.toLowerCase() === host.toLowerCase() &&
      ['http:', 'https:'].includes(originUrl.protocol) &&
      allowedHosts.has(requestHost) &&
      originHost === requestHost
    );
  } catch {
    return false;
  }
}

function canAttemptLogin(address: string): boolean {
  const now = Date.now();
  const attempt = loginAttempts.get(address);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(address, { count: 0, resetAt: now + 60_000 });
    return true;
  }
  return attempt.count < 8;
}

function recordLoginFailure(address: string): void {
  const attempt = loginAttempts.get(address);
  if (attempt) attempt.count += 1;
}

function clearLoginFailures(address: string): void {
  loginAttempts.delete(address);
}

async function verifyPassword(
  db: Kysely<Schema>,
  username: string,
  password: string,
): Promise<WebUser | null> {
  if (
    Buffer.byteLength(password, 'utf8') > PASSWORD_BYTES ||
    !/^[a-z0-9._-]{3,40}$/i.test(username.trim())
  ) {
    passwordHash('invalid-credential', 'missing-user-timing-salt');
    return null;
  }
  const row = await db
    .selectFrom('web_users')
    .select(['id', 'username', 'role', 'password_hash', 'password_salt'])
    .where('username', '=', username.trim().toLowerCase())
    .where('disabled', '=', 0)
    .executeTakeFirst();
  if (!row) {
    passwordHash(password, 'missing-user-timing-salt');
    return null;
  }
  const expected = Buffer.from(row.password_hash, 'hex');
  const actual = passwordHash(password, row.password_salt);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  return userFromRow(row);
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
): Promise<boolean> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  let relative =
    pathname === '/' || !path.extname(pathname)
      ? 'index.html'
      : pathname.slice(1);
  try {
    relative = decodeURIComponent(relative);
  } catch {
    return false;
  }
  const filePath = path.resolve(webRoot, relative);
  if (
    !filePath.startsWith(`${path.resolve(webRoot)}${path.sep}`) &&
    filePath !== path.join(path.resolve(webRoot), 'index.html')
  ) {
    return false;
  }
  let contents: Buffer;
  try {
    contents = await fs.readFile(filePath);
  } catch {
    return false;
  }
  const extension = path.extname(filePath);
  const contentType =
    extension === '.html'
      ? 'text/html; charset=utf-8'
      : extension === '.js'
        ? 'text/javascript; charset=utf-8'
        : extension === '.css'
          ? 'text/css; charset=utf-8'
          : extension === '.svg'
            ? 'image/svg+xml'
            : extension === '.webmanifest'
              ? 'application/manifest+json'
              : extension === '.png'
                ? 'image/png'
                : extension === '.webp'
                  ? 'image/webp'
                  : 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': [
      'index.html',
      'service-worker.js',
      'manifest.webmanifest',
    ].includes(path.basename(filePath))
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  response.end(contents);
  return true;
}

export async function startWebServer(
  database: AppDatabase,
  options: WebServerOptions = {},
): Promise<() => void> {
  const host = process.env.WEB_HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 4173);
  const secureCookie = process.env.WEB_COOKIE_SECURE === '1';
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Le port WEB_PORT/PORT doit être valide.');
  }
  if (!isLoopback && !secureCookie) {
    throw new Error(
      'WEB_COOKIE_SECURE=1 est obligatoire derrière HTTPS pour une écoute réseau.',
    );
  }

  const userCountRow = await database.db
    .selectFrom('web_users')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  const userCount = Number(userCountRow.count);
  if (userCount === 0) {
    const username = process.env.WEB_ADMIN_USERNAME;
    const password = process.env.WEB_ADMIN_PASSWORD;
    if (!username || !password) {
      throw new Error(
        'Initialisez le premier compte avec WEB_ADMIN_USERNAME et WEB_ADMIN_PASSWORD.',
      );
    }
    await createUser(database.db, username, password, 'admin');
    console.info('[web] Initial administrator account created.');
  }

  const webRoot = options.webRoot ?? path.resolve(process.cwd(), 'dist/web');
  const userData =
    options.userDataPath ??
    path.resolve(process.env.WEB_USER_DATA_DIR ?? 'user-data');
  const settings = new SettingsService(database.db);
  const backupService = database.sqlite
    ? new BackupService(
        database.db,
        path.join(userData, 'complex-scolaire.sqlite'),
        settings,
      )
    : null;
  if (backupService) {
    await backupService
      .runAutoBackupIfDue(userData)
      .catch((error: unknown) =>
        console.error('[web] Initial automatic backup failed:', error),
      );
  }

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`,
    );
    const address = request.socket.remoteAddress ?? 'unknown';

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && !sameOrigin(request)) {
          sendJson(response, 403, {
            error: 'Origine de requête non autorisée.',
          });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/login') {
          if (!canAttemptLogin(address)) {
            sendJson(response, 429, {
              error: 'Trop de tentatives. Réessayez dans une minute.',
            });
            return;
          }
          const body = await readJson(request);
          const username =
            typeof body.username === 'string' ? body.username : '';
          const password =
            typeof body.password === 'string' ? body.password : '';
          const user = await verifyPassword(database.db, username, password);
          if (!user) {
            recordLoginFailure(address);
            sendJson(response, 401, { error: 'Identifiants incorrects.' });
            return;
          }
          clearLoginFailures(address);
          const token = randomBytes(32).toString('base64url');
          sessions.set(hashToken(token), {
            ...user,
            expiresAt: Date.now() + SESSION_TTL_MS,
          });
          sendJson(
            response,
            200,
            { user },
            { 'Set-Cookie': cookieValue(token, secureCookie) },
          );
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
          const token = getCookie(request, SESSION_COOKIE);
          if (token) sessions.delete(hashToken(token));
          sendJson(
            response,
            200,
            { ok: true },
            { 'Set-Cookie': cookieValue(null, secureCookie) },
          );
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/auth/me') {
          const session = getSession(request);
          sendJson(response, 200, {
            user: session
              ? {
                  id: session.id,
                  username: session.username,
                  role: session.role,
                }
              : null,
          });
          return;
        }

        const session = getSession(request);
        if (!session) {
          sendJson(response, 401, { error: 'Connexion requise.' });
          return;
        }

        if (url.pathname === '/api/admin/users') {
          if (session.role !== 'admin') {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          if (request.method === 'GET') {
            const users = await database.db
              .selectFrom('web_users')
              .select(['id', 'username', 'role', 'created_at', 'disabled'])
              .orderBy('username')
              .execute();
            sendJson(response, 200, users);
            return;
          }
          if (request.method === 'POST') {
            const body = await readJson(request);
            if (
              typeof body.username !== 'string' ||
              typeof body.password !== 'string'
            ) {
              sendJson(response, 400, {
                error: 'Nom d’utilisateur et mot de passe requis.',
              });
              return;
            }
            const role = body.role === 'admin' ? 'admin' : 'staff';
            try {
              const user = await createUser(
                database.db,
                body.username,
                body.password,
                role,
              );
              sendJson(response, 201, user);
            } catch (error) {
              if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === '23505'
              ) {
                sendJson(response, 409, {
                  error: 'Ce nom d’utilisateur existe déjà.',
                });
                return;
              }
              throw error;
            }
            return;
          }
        }

        const userIdMatch = /^\/api\/admin\/users\/(\d+)$/.exec(url.pathname);
        if (userIdMatch && request.method === 'DELETE') {
          if (session.role !== 'admin') {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          const targetId = Number(userIdMatch[1]);
          if (targetId === session.id) {
            sendJson(response, 400, {
              error: 'Vous ne pouvez pas désactiver votre propre compte.',
            });
            return;
          }
          const target = await database.db
            .selectFrom('web_users')
            .select(['role', 'disabled'])
            .where('id', '=', targetId)
            .executeTakeFirst();
          if (!target || target.disabled) {
            sendJson(response, 404, {
              error: 'Compte introuvable ou déjà désactivé.',
            });
            return;
          }
          if (target.role === 'admin') {
            const activeAdminCount = await database.db
              .selectFrom('web_users')
              .select(({ fn }) => fn.countAll<number>().as('count'))
              .where('role', '=', 'admin')
              .where('disabled', '=', 0)
              .executeTakeFirstOrThrow();
            const activeAdmins = Number(activeAdminCount.count);
            if (activeAdmins <= 1) {
              sendJson(response, 400, {
                error:
                  'Le dernier compte administrateur ne peut pas être désactivé.',
              });
              return;
            }
          }
          await database.db
            .updateTable('web_users')
            .set({ disabled: 1 })
            .where('id', '=', targetId)
            .execute();
          for (const [token, activeSession] of sessions) {
            if (activeSession.id === targetId) sessions.delete(token);
          }
          sendJson(response, 200, { ok: true });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/logo') {
          if (session.role !== 'admin') {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          const body = await readJson(request);
          if (typeof body.dataUrl !== 'string') {
            sendJson(response, 400, { error: 'Image manquante.' });
            return;
          }
          const match =
            /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
              body.dataUrl,
            );
          if (!match) {
            sendJson(response, 400, { error: 'Format d’image invalide.' });
            return;
          }
          const data = Buffer.from(match[2], 'base64');
          if (data.length > 3 * 1024 * 1024) {
            sendJson(response, 413, {
              error: 'Le logo ne doit pas dépasser 3 Mo.',
            });
            return;
          }
          const isPng = data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          const isJpeg =
            data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
          if (
            (match[1] === 'image/png' && !isPng) ||
            (match[1] === 'image/jpeg' && !isJpeg)
          ) {
            sendJson(response, 400, {
              error: 'Le contenu ne correspond pas au format annoncé.',
            });
            return;
          }
          const extension = match[1] === 'image/png' ? '.png' : '.jpg';
          const logoPath = path.join(
            userData,
            'branding',
            `school-logo${extension}`,
          );
          await fs.mkdir(path.dirname(logoPath), { recursive: true });
          await fs.writeFile(logoPath, data);
          await settings.set('school_logo_path', logoPath);
          sendJson(response, 200, { path: logoPath });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/backup') {
          if (!backupService) {
            sendJson(response, 501, {
              error:
                'Les sauvegardes PostgreSQL doivent être effectuées avec les outils du fournisseur de base de données.',
            });
            return;
          }
          if (session.role !== 'admin') {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          const backupDirectory = path.join(userData, 'backups');
          await fs.mkdir(backupDirectory, { recursive: true });
          const fileName = `sauvegarde-complex-scolaire-${new Date().toISOString().slice(0, 10)}.sqlite`;
          const filePath = path.join(backupDirectory, fileName);
          const backedUpAt = await backupService.createToPath(filePath);
          const contents = await fs.readFile(filePath);
          response.writeHead(200, {
            'Content-Type': 'application/vnd.sqlite3',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Cache-Control': 'no-store',
            'X-Backup-Created-At': backedUpAt,
          });
          response.end(contents);
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/restore') {
          if (!database.sqlite) {
            sendJson(response, 501, {
              error:
                'La restauration PostgreSQL doit être effectuée avec les outils du fournisseur de base de données.',
            });
            return;
          }
          if (session.role !== 'admin') {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          const contents = await readBinary(request);
          const magic = Buffer.from('SQLite format 3\0', 'utf8');
          if (
            contents.length < magic.length ||
            !contents.subarray(0, magic.length).equals(magic)
          ) {
            sendJson(response, 400, {
              error:
                'Le fichier choisi n’est pas une sauvegarde SQLite valide.',
            });
            return;
          }
          const restorePath = path.join(
            userData,
            'backups',
            `restore-${randomBytes(8).toString('hex')}.sqlite`,
          );
          await fs.mkdir(path.dirname(restorePath), { recursive: true });
          await fs.writeFile(restorePath, contents);
          const [{ default: Database }, { app }] = await Promise.all([
            import('better-sqlite3'),
            import('electron'),
          ]);
          const validationDb = new Database(restorePath, {
            readonly: true,
            fileMustExist: true,
          });
          let isValid = false;
          try {
            const check = validationDb.pragma('quick_check') as Array<{
              quick_check: string;
            }>;
            isValid = check.every((row) => row.quick_check === 'ok');
          } finally {
            validationDb.close();
            if (!isValid) await fs.unlink(restorePath);
          }
          if (!isValid) {
            sendJson(response, 400, {
              error: 'La base de données de sauvegarde est endommagée.',
            });
            return;
          }
          const livePath = path.join(userData, 'complex-scolaire.sqlite');
          database.sqlite.pragma('wal_checkpoint(FULL)');
          database.sqlite.close();
          await fs.copyFile(restorePath, livePath);
          await fs.unlink(restorePath);
          sendJson(response, 200, { success: true });
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 500);
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/rpc') {
          const body = await readJson(request);
          if (
            typeof body.channel !== 'string' ||
            !IPC_CHANNELS.includes(
              body.channel as (typeof IPC_CHANNELS)[number],
            ) ||
            !Array.isArray(body.args)
          ) {
            sendJson(response, 400, { error: 'Opération API invalide.' });
            return;
          }
          if (
            session.role !== 'admin' &&
            ADMIN_ONLY_CHANNELS.has(body.channel)
          ) {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          if (
            session.role !== 'admin' &&
            body.channel === 'settings:set' &&
            !['ui_language', 'current_school_year'].includes(
              String(body.args[0] ?? ''),
            )
          ) {
            sendJson(response, 403, { error: 'Droits administrateur requis.' });
            return;
          }
          if (
            [
              'system:openExternal',
              'system:openLogsFolder',
              'settings:pickLogo',
              'backup:createNow',
              'backup:restore',
              'expenses:exportExcel',
              'treasury:exportExcel',
              'print:studentStatement',
              'print:paymentReceipt',
              'print:expenseRegister',
              'print:staffPaymentReceipt',
              'print:financialReport',
              'print:savePdfFromHtml',
            ].includes(body.channel)
          ) {
            sendJson(response, 400, {
              error: 'Cette action doit passer par l’interface web.',
            });
            return;
          }
          const result = await dispatchWebRequest(body.channel, body.args);
          sendJson(response, 200, { result });
          return;
        }

        sendJson(response, 404, { error: 'Route API inconnue.' });
        return;
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await serveStatic(request, response, webRoot)) return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      console.error('[web] Request failed:', error);
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Erreur serveur.',
        });
      } else {
        response.destroy();
      }
    }
  });

  server.on('error', (error) => {
    console.error('[web] HTTP server failed:', error);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  console.info(`[web] PWA server listening on http://${host}:${port}`);
  const automaticBackupTimer = backupService
    ? setInterval(
        () => {
          void backupService
            .runAutoBackupIfDue(userData)
            .catch((error: unknown) =>
              console.error('[web] Automatic backup failed:', error),
            );
        },
        60 * 60 * 1000,
      )
    : null;
  return () => {
    if (automaticBackupTimer) clearInterval(automaticBackupTimer);
    for (const token of sessions.keys()) sessions.delete(token);
    server.close();
  };
}
