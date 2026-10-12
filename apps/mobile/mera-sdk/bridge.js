import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
} from '@category-labs/mera';

// Runs only in the app's bundled, local WebView. Native WebAuthn ceremonies
// still use Android Credential Manager through the existing Flutter plugin.
const pending = new Map();
let nextId = 0;

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decode(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
    (character) => character.charCodeAt(0));
}

function nativeRequest(kind, request) {
  return new Promise((resolve, reject) => {
    const id = String(++nextId);
    pending.set(id, { resolve, reject });
    EyelerMeraNative.request(JSON.stringify({ id, kind, request }));
  });
}

window.eyelerMeraNativeResponse = (id, response) => {
  const task = pending.get(id);
  if (!task) return;
  pending.delete(id);
  const result = JSON.parse(response);
  if (result.error) {
    task.reject(new Error(result.error));
    return;
  }
  task.resolve(result);
};

const webAuthnClient = {
  async createCredential(request) {
    const result = await nativeRequest('create', {
      rp: request.rp,
      user: { ...request.user, id: encode(request.user.id) },
      challenge: encode(request.challenge),
      algorithms: request.algorithms,
      prfSalt: encode(request.prfSalt),
      residentKey: request.residentKey,
      userVerification: request.userVerification,
      attestation: request.attestation,
    });
    return {
      credentialId: decode(result.credentialId),
      transports: result.transports ?? [],
      prfEnabled: result.prfEnabled,
      prfOutput: result.prfOutput ? decode(result.prfOutput) : undefined,
    };
  },
  async getCredential(request) {
    const result = await nativeRequest('get', {
      rpId: request.rpId,
      challenge: encode(request.challenge),
      prfSalt: encode(request.prfSalt),
      userVerification: request.userVerification,
      allowCredential: request.allowCredential
        ? { credentialId: encode(request.allowCredential.credentialId),
            transports: request.allowCredential.transports ?? [] }
        : null,
    });
    return {
      credentialId: decode(result.credentialId),
      prfOutput: result.prfOutput ? decode(result.prfOutput) : undefined,
    };
  },
};

window.eyelerMeraSdk = {
  async run(id, operation, inputJson) {
    try {
      const input = JSON.parse(inputJson);
      if (input.rpId !== 'app.eyeler.xyz') throw new Error('Unexpected Mera RP ID');
      const result = operation === 'create'
        ? await createPasskeyWithPrfOutput({
            rp: { id: input.rpId, name: 'EYELER' },
            user: { name: input.label, displayName: input.label },
            webAuthnClient,
          })
        : operation === 'get'
          ? await getPasskeyPrfOutput({ rpId: input.rpId,
              credential: input.credentialId ? { credentialId: input.credentialId } : undefined,
              webAuthnClient })
          : (() => { throw new Error('Unsupported Mera operation'); })();
      EyelerMeraNative.complete(JSON.stringify({ id,
        credentialId: result.credentialId,
        prfOutput: encode(result.prfOutput) }));
      result.prfOutput.fill(0);
    } catch (error) {
      EyelerMeraNative.complete(JSON.stringify({ id, error: error?.code ?? 'MERA_FAILED' }));
    }
  },
};

EyelerMeraNative.ready();
