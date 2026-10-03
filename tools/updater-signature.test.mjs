import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyUpdaterSignature } from './updater-signature.mjs';

function fixture(prehashed) {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const keyId = Buffer.from('0102030405060708', 'hex');
	const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	const keyPacket = Buffer.concat([Buffer.from('Ed'), keyId, rawKey]);
	const key = Buffer.from(`untrusted comment: test key\n${keyPacket.toString('base64')}\n`).toString('base64');
	const data = Buffer.from('release installer');
	const message = prehashed ? createHash('blake2b512').update(data).digest() : data;
	const signature = sign(null, message, privateKey);
	const packet = Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), keyId, signature]);
	const comment = 'timestamp:1\tfile:installer';
	const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
	const encoded = Buffer.from(`untrusted comment: test signature\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
	return { data, signature: encoded, key };
}

for (const prehashed of [false, true]) {
	test(`verifies ${prehashed ? 'prehashed' : 'legacy'} signature and rejects corrupt installers`, () => {
		const f = fixture(prehashed);
		verifyUpdaterSignature(f.data, f.signature, f.key);
		assert.throws(() => verifyUpdaterSignature(Buffer.from('corrupt installer'), f.signature, f.key), /verification failed/);
	});
}
test('rejects another signing key even if its key ID is reused', () => {
	const f = fixture(true);
	assert.throws(() => verifyUpdaterSignature(f.data, f.signature, fixture(true).key), /verification failed/);
});
test('rejects mismatching key IDs', () => {
	const f = fixture(true);
	const lines = Buffer.from(f.key, 'base64').toString().trim().split('\n');
	const packet = Buffer.from(lines[1], 'base64');
	packet[2] ^= 1;
	lines[1] = packet.toString('base64');
	const wrongKey = Buffer.from(lines.join('\n')).toString('base64');
	assert.throws(() => verifyUpdaterSignature(f.data, f.signature, wrongKey), /different key/);
});
test('rejects tampered trusted comments and malformed signatures', () => {
	const f = fixture(true);
	const tampered = Buffer.from(Buffer.from(f.signature, 'base64').toString().replace('timestamp:1', 'timestamp:2')).toString('base64');
	assert.throws(() => verifyUpdaterSignature(f.data, tampered, f.key), /verification failed/);
	assert.throws(() => verifyUpdaterSignature(f.data, 'invalid', f.key), /Invalid updater signature/);
});
