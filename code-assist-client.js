// code-assist-client.js -- Code Assist API client
// Mirrors the Gemini CLI's CodeAssistServer for direct API access.

const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = process.env.GEMINI_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET || '';
const OAUTH_CREDS_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
const G1_CREDIT_TYPE = 'GOOGLE_ONE_AI';

class CodeAssistClient {
  constructor() {
    this.oauthClient = null;
    this.projectId = null;
    this.userTier = null;
    this.enableCredits = false;
    this.initialized = false;
    this.activeAbort = null;
  }

  async init() {
    if (this.initialized) return;

    if (!fs.existsSync(OAUTH_CREDS_PATH)) {
      throw new Error('NO_CREDENTIALS');
    }

    const creds = JSON.parse(fs.readFileSync(OAUTH_CREDS_PATH, 'utf-8'));
    this.oauthClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
    this.oauthClient.setCredentials({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
      token_type: creds.token_type,
    });

    const setupResp = await this._post('loadCodeAssist', {
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    });

    this.projectId = setupResp.cloudaicompanionProject || '';
    if (setupResp.currentTier) {
      this.userTier = setupResp.currentTier.id;
      this.enableCredits = this.userTier === 'standard-tier';
    }

    this.initialized = true;
  }

  async _post(method, body) {
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;
    const res = await this.oauthClient.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: body,
    });
    return res.data;
  }

  async *_streamPost(method, body, signal) {
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;
    const res = await this.oauthClient.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: body,
      params: { alt: 'sse' },
      responseType: 'stream',
      signal,
    });

    const rl = readline.createInterface({
      input: res.data,
      crlfDelay: Infinity,
    });

    let bufferedLines = [];
    for await (const line of rl) {
      if (line.startsWith('data: ')) {
        bufferedLines.push(line.slice(6).trim());
      } else if (line === '') {
        if (bufferedLines.length === 0) continue;
        try {
          yield JSON.parse(bufferedLines.join('\n'));
        } catch (e) {
          console.error('SSE parse error:', e.message);
        }
        bufferedLines = [];
      }
    }
  }

  async streamMessage(opts) {
    if (!this.initialized) await this.init();

    const abortController = new AbortController();
    this.activeAbort = abortController;

    const requestBody = {
      model: opts.model,
      project: this.projectId,
      user_prompt_id: crypto.randomUUID(),
      request: {
        contents: opts.contents,
        generationConfig: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
        },
        session_id: opts.sessionId || '',
      },
    };

    if (opts.systemInstruction) {
      requestBody.request.systemInstruction = opts.systemInstruction;
    }

    if (this.enableCredits) {
      requestBody.enabled_credit_types = [G1_CREDIT_TYPE];
    }

    try {
      for await (const chunk of this._streamPost('streamGenerateContent', requestBody, abortController.signal)) {
        if (opts.onChunk) opts.onChunk(chunk);
      }
      if (opts.onDone) opts.onDone();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (opts.onDone) opts.onDone();
      } else {
        if (opts.onError) opts.onError(err);
        else throw err;
      }
    } finally {
      this.activeAbort = null;
    }
  }

  cancel() {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  static hasCredentials() {
    return fs.existsSync(OAUTH_CREDS_PATH);
  }
}

module.exports = { CodeAssistClient };
