import { createHash, verify as verifySignature, X509Certificate } from "node:crypto";
import { TSA_TRUST_ANCHORS } from "./tsa-trust.js";

/**
 * Verifies an RFC 3161 timestamp token (a CMS SignedData over TSTInfo) the way
 * `openssl ts -verify` does, with Node built-ins only:
 *
 * 1. TSTInfo's messageImprint is sha256 over the expected digest, and its
 *    nonce is the one we sent.
 * 2. The signedAttrs messageDigest equals the hash of the TSTInfo bytes.
 * 3. One certificate in the token verifies the SignerInfo signature over the
 *    DER-encoded signedAttrs, and carries the timeStamping extended key usage.
 * 4. That certificate chains, through certificates in the token, to a pinned
 *    root in tsa-trust.ts, each link checked by signature and issuer name.
 *
 * The token is untrusted input (the DigiCert responder is plain HTTP), so any
 * structural surprise is a verification failure, never a pass.
 */

interface Node {
  tag: number;
  start: number; // first content byte
  end: number; // one past the last content byte
  headerStart: number;
}

function read(buf: Buffer, offset: number): Node {
  const tag = buf[offset];
  const first = buf[offset + 1];
  if (tag === undefined || first === undefined) throw new Error("truncated DER");
  let length = first;
  let start = offset + 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new Error("unsupported DER length");
    length = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = buf[start + i];
      if (byte === undefined) throw new Error("truncated DER");
      length = length * 256 + byte;
    }
    start += count;
  }
  const end = start + length;
  if (end > buf.length) throw new Error("truncated DER");
  return { tag, start, end, headerStart: offset };
}

function children(buf: Buffer, node: Node): Node[] {
  const out: Node[] = [];
  for (let offset = node.start; offset < node.end; ) {
    const child = read(buf, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

function expectTag(node: Node | undefined, tag: number, what: string): Node {
  if (!node || node.tag !== tag) throw new Error(`${what}: unexpected structure`);
  return node;
}

function oid(buf: Buffer, node: Node): string {
  const bytes = buf.subarray(node.start, node.end);
  const parts: number[] = [];
  let value = 0;
  bytes.forEach((byte, index) => {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      if (index === 0 || parts.length === 0) {
        parts.push(Math.min(2, Math.floor(value / 40)), value - Math.min(2, Math.floor(value / 40)) * 40);
      } else {
        parts.push(value);
      }
      value = 0;
    }
  });
  return parts.join(".");
}

const OID = {
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  messageDigest: "1.2.840.113549.1.9.4",
  contentType: "1.2.840.113549.1.9.3",
  sha256: "2.16.840.1.101.3.4.2.1",
  timeStamping: "1.3.6.1.5.5.7.3.8"
} as const;

const DIGESTS: Record<string, string> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512"
};

/** Signature algorithms with the hash they imply, if any. */
const SIGNATURES: Record<string, string | null> = {
  "1.2.840.113549.1.1.1": null, // rsaEncryption: hash from SignerInfo.digestAlgorithm
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512"
};

export interface TimestampVerification {
  verified: boolean;
  reason: string | null;
  genTime: string | null;
  signer: string | null;
  anchor: string | null;
}

function unsignedInteger(buf: Buffer, node: Node): Buffer {
  let bytes = buf.subarray(node.start, node.end);
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  return bytes;
}

function parseGeneralizedTime(text: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? frac.slice(0, 4).padEnd(4, "0") : ".000"}Z`;
}

function chainToAnchor(signer: X509Certificate, bag: X509Certificate[]): string | null {
  const anchors = TSA_TRUST_ANCHORS.map((anchor) => ({ name: anchor.name, cert: new X509Certificate(anchor.pem) }));
  let current = signer;
  for (let depth = 0; depth < 6; depth += 1) {
    for (const anchor of anchors) {
      if (current.fingerprint256 === anchor.cert.fingerprint256) return anchor.name;
      if (current.checkIssued(anchor.cert) && current.verify(anchor.cert.publicKey)) return anchor.name;
    }
    const issuer = bag.find(
      (candidate) => candidate !== current && current.checkIssued(candidate) && current.verify(candidate.publicKey)
    );
    if (!issuer) return null;
    current = issuer;
  }
  return null;
}

export function verifyTimestampToken(
  token: Buffer,
  expectedDigest: Buffer,
  expectedNonce: Buffer
): TimestampVerification {
  const fail = (reason: string): TimestampVerification => ({ verified: false, reason, genTime: null, signer: null, anchor: null });
  try {
    // ContentInfo
    const contentInfo = expectTag(read(token, 0), 0x30, "ContentInfo");
    const [contentType, explicit] = children(token, contentInfo);
    if (oid(token, expectTag(contentType, 0x06, "contentType")) !== OID.signedData) return fail("not SignedData");
    const signedData = expectTag(children(token, expectTag(explicit, 0xa0, "content"))[0], 0x30, "SignedData");
    const parts = children(token, signedData);
    const encap = expectTag(parts[2], 0x30, "encapContentInfo");
    const [eContentType, eContentWrap] = children(token, encap);
    if (oid(token, expectTag(eContentType, 0x06, "eContentType")) !== OID.tstInfo) return fail("content is not TSTInfo");
    const eContent = expectTag(children(token, expectTag(eContentWrap, 0xa0, "eContent"))[0], 0x04, "eContent");
    const tstBytes = token.subarray(eContent.start, eContent.end);

    // TSTInfo: version, policy, messageImprint, serialNumber, genTime, [accuracy], [ordering], [nonce], ...
    const tst = expectTag(read(tstBytes, 0), 0x30, "TSTInfo");
    const tstParts = children(tstBytes, tst);
    const imprint = children(tstBytes, expectTag(tstParts[2], 0x30, "messageImprint"));
    const imprintAlg = oid(tstBytes, expectTag(children(tstBytes, expectTag(imprint[0], 0x30, "hashAlgorithm"))[0], 0x06, "hash OID"));
    const hashed = tstBytes.subarray(expectTag(imprint[1], 0x04, "hashedMessage").start, imprint[1]!.end);
    if (imprintAlg !== OID.sha256 || !hashed.equals(expectedDigest)) return fail("messageImprint does not match the chain head");
    const genTimeNode = expectTag(tstParts[4], 0x18, "genTime");
    const genTime = parseGeneralizedTime(tstBytes.subarray(genTimeNode.start, genTimeNode.end).toString("ascii"));
    const nonceNode = tstParts.slice(5).find((node) => node.tag === 0x02);
    const nonce = nonceNode ? unsignedInteger(tstBytes, nonceNode) : null;
    let wanted = expectedNonce;
    while (wanted.length > 1 && wanted[0] === 0) wanted = wanted.subarray(1);
    if (!nonce || !nonce.equals(wanted)) return fail("nonce does not match the request");

    // Certificates ([0] IMPLICIT) and the single SignerInfo.
    const certSet = parts.find((node) => node.tag === 0xa0);
    const bag = certSet
      ? children(token, certSet)
          .filter((node) => node.tag === 0x30)
          .map((node) => new X509Certificate(token.subarray(node.headerStart, node.end)))
      : [];
    const signerInfos = expectTag(parts[parts.length - 1], 0x31, "signerInfos");
    const signerInfoNodes = children(token, signerInfos);
    if (signerInfoNodes.length !== 1) return fail("expected one SignerInfo");
    const si = children(token, expectTag(signerInfoNodes[0], 0x30, "SignerInfo"));
    const digestAlgOid = oid(token, expectTag(children(token, expectTag(si[2], 0x30, "digestAlgorithm"))[0], 0x06, "digest OID"));
    const signedAttrs = expectTag(si[3], 0xa0, "signedAttrs");
    const sigAlgOid = oid(token, expectTag(children(token, expectTag(si[4], 0x30, "signatureAlgorithm"))[0], 0x06, "signature OID"));
    const signatureNode = expectTag(si[5], 0x04, "signature");
    const digestName = DIGESTS[digestAlgOid];
    if (!digestName) return fail(`unsupported digest ${digestAlgOid}`);
    if (!(sigAlgOid in SIGNATURES)) return fail(`unsupported signature algorithm ${sigAlgOid}`);
    const signatureHash = SIGNATURES[sigAlgOid] ?? digestName;

    // signedAttrs: contentType must be TSTInfo; messageDigest must match.
    let messageDigest: Buffer | null = null;
    let attrContentType: string | null = null;
    for (const attr of children(token, signedAttrs)) {
      const [type, values] = children(token, expectTag(attr, 0x30, "Attribute"));
      const typeOid = oid(token, expectTag(type, 0x06, "attribute OID"));
      const value = children(token, expectTag(values, 0x31, "attribute values"))[0];
      if (typeOid === OID.messageDigest && value?.tag === 0x04) messageDigest = token.subarray(value.start, value.end);
      if (typeOid === OID.contentType && value?.tag === 0x06) attrContentType = oid(token, value);
    }
    if (attrContentType !== OID.tstInfo) return fail("signed contentType is not TSTInfo");
    if (!messageDigest || !messageDigest.equals(createHash(digestName).update(tstBytes).digest())) {
      return fail("messageDigest does not match TSTInfo");
    }

    // The signature covers signedAttrs re-tagged as SET OF (0x31).
    const signedBytes = Buffer.from(token.subarray(signedAttrs.headerStart, signedAttrs.end));
    signedBytes[0] = 0x31;
    const signature = token.subarray(signatureNode.start, signatureNode.end);
    const signer = bag.find((cert) => {
      try {
        return verifySignature(signatureHash, signedBytes, cert.publicKey, signature);
      } catch {
        return false;
      }
    });
    if (!signer) return fail("no certificate in the token verifies the signature");
    const usages = signer.keyUsage ?? [];
    if (!usages.includes(OID.timeStamping)) return fail("signer lacks the timeStamping extended key usage");
    if (genTime) {
      const at = Date.parse(genTime);
      if (at < Date.parse(signer.validFrom) || at > Date.parse(signer.validTo)) return fail("signer certificate not valid at genTime");
    }
    const anchor = chainToAnchor(signer, bag);
    if (!anchor) return fail("signer does not chain to a pinned TSA root");
    return { verified: true, reason: null, genTime, signer: signer.subject.replace(/\n/g, ", "), anchor };
  } catch (error) {
    return fail(`malformed token: ${error instanceof Error ? error.message : String(error)}`);
  }
}
