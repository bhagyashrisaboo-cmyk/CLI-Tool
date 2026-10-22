/**
 * Draft backends.
 *
 * SAFETY: ActionTrack only ever creates *drafts*. No code path in this module
 * calls a send endpoint; GmailApiBackend uses users.drafts.create exclusively.
 * A human reviews and sends the draft from Gmail.
 *
 * GmailApiBackend  - creates a draft in the user's Gmail via the Gmail API
 *                    (OAuth "Desktop app" client, scope gmail.compose).
 * OutboxBackend    - writes an .eml file to a local folder; used for
 *                    --outbox and as the automatic fallback when Gmail is
 *                    unavailable, so no follow-up is ever lost.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GmailUnavailableError } from './errors.js';
import { logger } from './logger.js';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];

const INSTALL_HINT = 'Install the optional Gmail packages:  npm install googleapis @google-cloud/local-auth';

function credentialsHint(credentialsPath) {
  return [
    'To enable Gmail drafts:',
    '  1. In Google Cloud Console, enable the Gmail API for a project.',
    '  2. Create an OAuth client ID of type "Desktop app" and download the JSON.',
    `  3. Save it as ${credentialsPath}`,
    '  4. Run:  actiontrack auth',
  ].join('\n');
}

function toBase64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importOptional(name) {
  try {
    return await import(name);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(err.message)) {
      throw new GmailUnavailableError(`Gmail support is not installed (missing "${name}").`, INSTALL_HINT);
    }
    throw new GmailUnavailableError(`Could not load "${name}": ${err.message}`, INSTALL_HINT);
  }
}

export class GmailApiBackend {
  /**
   * @param {object} opts
   * @param {string} opts.credentialsPath OAuth client JSON
   * @param {string} opts.tokenPath cached token JSON
   * @param {boolean} [opts.interactive] allow opening a browser for consent
   * @param {object} [opts.gmailClient] injected client (tests): { users: { drafts: { create } } }
   */
  constructor({ credentialsPath, tokenPath, interactive = false, gmailClient = null }) {
    this.credentialsPath = credentialsPath;
    this.tokenPath = tokenPath;
    this.interactive = interactive;
    this.gmailClient = gmailClient;
    this.name = 'gmail';
  }

  async authorize() {
    if (!fs.existsSync(this.credentialsPath)) {
      throw new GmailUnavailableError('Gmail is not set up: OAuth client credentials not found.', credentialsHint(this.credentialsPath));
    }
    let keys;
    try {
      const raw = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
      keys = raw.installed || raw.web;
      if (!keys?.client_id || !keys?.client_secret) throw new Error('missing client_id/client_secret');
    } catch (err) {
      throw new GmailUnavailableError(`Invalid Gmail credentials file ${this.credentialsPath}: ${err.message}`, credentialsHint(this.credentialsPath));
    }

    const { google } = await importOptional('googleapis');

    if (fs.existsSync(this.tokenPath)) {
      try {
        const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        const client = new google.auth.OAuth2(keys.client_id, keys.client_secret);
        client.setCredentials(token);
        client.on?.('tokens', (t) => this.saveToken({ ...token, ...t }));
        return client;
      } catch (err) {
        logger.warn(`ignoring unreadable Gmail token ${this.tokenPath}: ${err.message}`);
      }
    }

    if (!this.interactive) {
      throw new GmailUnavailableError('Gmail is not authorised yet.', 'Run "actiontrack auth" once to sign in to Google.');
    }
    const { authenticate } = await importOptional('@google-cloud/local-auth');
    let client;
    try {
      client = await authenticate({ scopes: GMAIL_SCOPES, keyfilePath: this.credentialsPath });
    } catch (err) {
      throw new GmailUnavailableError(`Google sign-in failed: ${err.message}`);
    }
    if (client.credentials?.refresh_token) {
      this.saveToken({
        type: 'authorized_user',
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        ...client.credentials,
      });
    }
    return client;
  }

  saveToken(token) {
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
      fs.writeFileSync(this.tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
    } catch (err) {
      logger.warn(`could not save Gmail token: ${err.message}`);
    }
  }

  async client() {
    if (this.gmailClient) return this.gmailClient;
    const auth = await this.authorize();
    const { google } = await importOptional('googleapis');
    this.gmailClient = google.gmail({ version: 'v1', auth });
    return this.gmailClient;
  }

  /**
   * Create a Gmail draft. Never sends.
   * @param {string} mime RFC 5322 message
   * @returns {Promise<{backend: string, id: string, location: string}>}
   */
  async createDraft(mime) {
    const gmail = await this.client();
    try {
      const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: toBase64Url(mime) } } });
      const id = res?.data?.id;
      if (!id) throw new Error('Gmail returned no draft id');
      return { backend: this.name, id, location: 'https://mail.google.com/mail/#drafts' };
    } catch (err) {
      throw translateApiError(err, this.tokenPath);
    }
  }
}

function translateApiError(err, tokenPath) {
  if (err instanceof GmailUnavailableError) return err;
  const status = err?.code || err?.response?.status;
  const msg = err?.response?.data?.error_description || err?.response?.data?.error?.message || err?.message || String(err);
  if (status === 401 || /invalid_grant|invalid_token|unauthori[sz]ed/i.test(msg)) {
    return new GmailUnavailableError(`Gmail rejected the saved sign-in (${msg}).`, `Delete ${tokenPath} and run "actiontrack auth" again.`);
  }
  if (status === 403) {
    return new GmailUnavailableError(`Gmail refused the request (${msg}).`, 'Check that the Gmail API is enabled and that you granted the "compose" permission.');
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(msg)) {
    return new GmailUnavailableError(`Could not reach Gmail (${msg}).`, 'Check your internet connection and try again.');
  }
  return new GmailUnavailableError(`Gmail draft creation failed: ${msg}`);
}

export class OutboxBackend {
  constructor(dir) {
    this.dir = dir;
    this.name = 'outbox';
  }

  async createDraft(mime, { slug = 'followup', now = new Date() } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'followup';
    let file = path.join(this.dir, `${stamp}-${safe}.eml`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(this.dir, `${stamp}-${safe}-${n}.eml`);
    fs.writeFileSync(file, mime);
    return { backend: this.name, id: path.basename(file), location: file };
  }
}
