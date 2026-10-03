// Tauri が使用する minisign-verify と同じ方式で更新ファイルを検証する。
import { createHash, createPublicKey, verify } from 'node:crypto';

export function publicKeyPacket(encodedKey) {
	const lines = Buffer.from(encodedKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
	const packet = Buffer.from(lines[1] ?? '', 'base64');
	if (packet.length !== 42 || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString())) {
		throw new Error('Invalid updater public key');
	}
	return packet;
}

export function verifyUpdaterSignature(data, encodedSignature, encodedKey) {
	const keyPacket = publicKeyPacket(encodedKey);
	const lines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
	const packet = Buffer.from(lines[1] ?? '', 'base64');
	const globalSignature = Buffer.from(lines[3] ?? '', 'base64');
	const algorithm = packet.subarray(0, 2).toString();
	if (packet.length !== 74 || globalSignature.length !== 64 || !['Ed', 'ED'].includes(algorithm)
		|| !lines[2]?.startsWith('trusted comment: ')) {
		throw new Error('Invalid updater signature');
	}
	if (!packet.subarray(2, 10).equals(keyPacket.subarray(2, 10))) {
		throw new Error('Updater signature was created with a different key');
	}
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyPacket.subarray(10)]),
		format: 'der', type: 'spki',
	});
	const signature = packet.subarray(10);
	const signedData = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
	if (!verify(null, signedData, key, signature)
		|| !verify(null, Buffer.concat([signature, Buffer.from(lines[2].slice(17))]), key, globalSignature)) {
		throw new Error('Updater signature verification failed');
	}
}
