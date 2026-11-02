import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

// Minimal software authenticator: real ES256 signatures and CBOR attestation,
// deliberately independent of the server verifier. Fictional credentials only.
function cbor(value: unknown): Buffer {
  const header = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (Buffer.isBuffer(value))
    return Buffer.concat([header(2, value.length), value]);
  if (typeof value === "string") {
    const b = Buffer.from(value);
    return Buffer.concat([header(3, b.length), b]);
  }
  if (typeof value === "number")
    return value >= 0 ? header(0, value) : header(1, -1 - value);
  if (value instanceof Map)
    return Buffer.concat([
      header(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  throw new Error("Unsupported fixture CBOR");
}
export class SoftwareAuthenticator {
  private readonly key = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  private readonly id = randomBytes(32);
  private counter = 0;
  registration(challenge: string, origin: string, uv = true) {
    const jwk = this.key.publicKey.export({ format: "jwk" });
    const publicKey = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const authData = Buffer.concat([
      this.rpHash(origin),
      Buffer.from([uv ? 0x45 : 0x41]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      Buffer.from([0, this.id.length]),
      this.id,
      publicKey,
    ]);
    return {
      id: this.id.toString("base64url"),
      rawId: this.id.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: cbor(
          new Map<string, unknown>([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
          ]),
        ).toString("base64url"),
        transports: ["internal"],
      },
    };
  }
  authentication(challenge: string, origin: string, uv = true) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([
      this.rpHash(origin),
      Buffer.from([uv ? 5 : 1]),
      counter,
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authData,
        createHash("sha256").update(clientDataJSON).digest(),
      ]),
      this.key.privateKey,
    );
    return {
      id: this.id.toString("base64url"),
      rawId: this.id.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: Buffer.from("context-owner").toString("base64url"),
      },
    };
  }
  private rpHash(origin: string) {
    return createHash("sha256").update(new URL(origin).hostname).digest();
  }
}
