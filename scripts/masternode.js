"use strict";

/**
    * Construct a masternode
    * @param {string} [masternode.walletPrivateKeyPath] - BIP39 path pointing to the private key holding the collateral. Optional if not HD
    * @param {string} masternode.mnPrivateKey - Masternode private key. Must be uncompressed WIF
    * @param {string} masternode.collateralTxId - Must be a UTXO pointing to the collateral
    * @param {number} masternode.outidx - The output id of the collateral starting from 0
    * @param {string} masternode.addr - IPV4 address in the form `ip:port`
*/
class Masternode {
    constructor({walletPrivateKeyPath, mnPrivateKey, collateralTxId, outidx, addr} = {}) {
	this.walletPrivateKeyPath = walletPrivateKeyPath;
	this.mnPrivateKey = mnPrivateKey;
	this.collateralTxId = collateralTxId;
	this.outidx = outidx;
	this.addr = addr;
    }
    
    static _getProtocolVersion(){
	return cChainParams.current.isTestnet ? 70926 : 70924;
    }
    
    async _getWalletPrivateKey(){
	return await masterKey.getPrivateKey(this.walletPrivateKeyPath);
    }
    
    /**
       @return {Promise<Object>} The object containing masternode information for this masternode
     */
    async getFullData(){
	const strURL = `${cNode.url}/listmasternodes?params=${this.collateralTxId}`;
	try {
	    const cMasternodes = (await (await fetch(strURL)).json()).filter(m => m.outidx === this.outidx);
	    if(cMasternodes.length > 0) {
		return cMasternodes[0];
	    } else {
		return {status: "MISSING"};
	    }
	} catch(e) { //this is the unfortunate state in which the node is not reachable
	    console.error(e);
	    return "EXPLORER_DOWN";
	}
    }

    /**
       @return {Promise<string>} The status of this masternode.
     */
    async getStatus() {
	const cMasternode = await this.getFullData();
	return cMasternode ? cMasternode.status : "MISSING";
    }
    
    static _decodeIpAddress(ip, port) {
	// Only IPV4 for now
	let start = '00000000000000000000ffff';
	for (const digit of ip.split('.').map(n=>parseInt(n))) {
	    start += ('0' + (digit).toString(16)).slice(-2);
	}
	start += Crypto.util.bytesToHex(Masternode._numToBytes(port, 2, false));
	return start;
    }

    static _numToBytes(number, numBytes=8, littleEndian = true) {
		const bytes = [];
		for(let i=0; i<numBytes; i++) {
			bytes.push((number / 2**(8*i)) & 0xFF);
		}
		return littleEndian ? bytes : bytes.reverse();
    }

    /**
     * @param {Object} message - message to encode
     * @param {string} message.vin.txid - transaction id of the collateral
     * @param {number} message.vin.idx - output id of the collateral starting from 0
     * @param {string} message.blockHash - latest blockhash
     * @param {number} message.sigTime - current time in seconds since UNIX epoch
     * @return {Array} Returns the unsigned ping message. It needs to be signed with the MN private key
     */
    static getPingSignature({vin, blockHash, sigTime}) {

	const ping = [
	    ...Crypto.util.hexToBytes(vin.txid).reverse(),
	    ...Masternode._numToBytes(vin.idx, 4, true),
	    // Should be tx sequence, but 0xffffff is fine
	    ...[0, 255, 255, 255, 255],
	    ...Crypto.util.hexToBytes(blockHash).reverse(),
	    ...Masternode._numToBytes(sigTime, 8, true),
	];
	const hash = new jsSHA(0, 0, {numRounds: 2});
	hash.update(ping);
	return hash.getHash(0);
    }

    /**
     * @param {Object} message - Message to encode
     * @param {string} message.walletPrivateKey - private key of the collateral
     * @param {string} message.addr - Masternode ipv4 with port
     * @param {string} message.mnPrivateKey - private key of masternode
     * @param {number} message.sigTime - current time in seconds since UNIX epoch
     * @return {string} The message to be signed with the collateral private key.
     * it needs to be padded with "\x18DarkNet Signed Message:\n" + Message length + Message
     * Then hashed two times with SHA256
     */
    static getToSign({walletPrivateKey, addr, mnPrivateKey, sigTime}) {
	const [ ip, port ] = addr.split(":");
	const publicKey = deriveAddress({
	    pkBytes: parseWIF(walletPrivateKey, true),
	    output: "RAW_BYTES",
	    compress: true,
	});
	const mnPublicKey = deriveAddress({
	    pkBytes: parseWIF(mnPrivateKey, true),
	    output: "RAW_BYTES",
	    compress: false,
	});

	const pkt = [
	    ...Masternode._numToBytes(1, 4, true), // Message version
	    ...Crypto.util.hexToBytes(Masternode._decodeIpAddress(ip, port)), // Encoded ip + port
	    ...Masternode._numToBytes(sigTime, 8, true),
	    ...Masternode._numToBytes(publicKey.length, 1, true), // Collateral public key length
	    ...publicKey,
	    ...Masternode._numToBytes(mnPublicKey.length, 1, true), // Masternode public key length
	    ...mnPublicKey,
	    ...Masternode._numToBytes(Masternode._getProtocolVersion(), 4, true), // Protocol version
	];
	const hash = new jsSHA(0, 0, {numRounds: 2});
	hash.update(pkt);
	// It's important to note that the thing to be signed is the hex representation of the hash, not the bytes
	return Crypto.util.bytesToHex(hash.getHash(0).reverse());
    }

    /**
     * @return {Promise<string>} The last block hash
     */
    static async getLastBlockHash() {
	const status = await (await fetch(`${cExplorer.url}/api/`)).json();
	return status.backend.bestBlockHash;
    }

    /**
     * @return {Promise<string>} The signed message signed with the collateral private key
     */
    async getSignedMessage(sigTime) {
	const padding = "\x18DarkNet Signed Message:\n"
	      .split("").map(c=>c.charCodeAt(0));
	const walletPrivateKey= await this._getWalletPrivateKey();
	const toSign = Masternode.getToSign({
	    addr: this.addr,
	    walletPrivateKey: walletPrivateKey,
	    mnPrivateKey: this.mnPrivateKey,
	    sigTime,
	}).split("").map(c=>c.charCodeAt(0));
	const hash = new jsSHA(0, 0, { numRounds: 2 });
	hash.update(padding
		    .concat(toSign.length)
		    .concat(toSign));
	const [ signature, v ] = await nobleSecp256k1.sign(hash.getHash(0), parseWIF(walletPrivateKey, true), { der: false, recovered: true});
	return [
	    v + 31, ...signature
	];
    }
    /**
     * @return {Promise<string>} The signed ping message signed with the masternode private key
     */
    async getSignedPingMessage(sigTime, blockHash) {
	const toSign = Masternode.getPingSignature({
	    vin: {
		txid: this.collateralTxId,
		idx: this.outidx,
	    },
	    blockHash,
	    sigTime,
	});
	const [ signature, v ] = await nobleSecp256k1.sign(toSign, parseWIF(this.mnPrivateKey, true), { der: false, recovered: true});
	return [
	    v + 27, ...signature,
	];
    }

    /**
     * Get the message encoded to hex used to start a masternode
     * It uses to two signatures: `getPingSignature()` which is signed
     * With the masternode private key, and `getToSign()` which is signed with
     * The collateral private key
     * @return {Promise<string>} The message used to start a masternode.
     */
    async broadcastMessageToHex() {
	const sigTime = Math.round(Date.now() / 1000);
	const blockHash = await Masternode.getLastBlockHash();
	const [ ip, port ] = this.addr.split(':');
	const walletPrivateKey=await this._getWalletPrivateKey()
	const walletPublicKey = deriveAddress({
	    pkBytes: parseWIF(walletPrivateKey, true),
	    output: "RAW_BYTES",
	    compress: true,
	});
	const mnPublicKey = deriveAddress({
	    pkBytes: parseWIF(this.mnPrivateKey, true),
	    output: "RAW_BYTES",
	    compress: false,
	});
	const sigBytes = await this.getSignedMessage(sigTime);
	const sigPingBytes = await this.getSignedPingMessage(sigTime, blockHash);

	const message = [
	    ...Crypto.util.hexToBytes(this.collateralTxId).reverse(),
	    ...Masternode._numToBytes(this.outidx, 4, true),
	    ...Masternode._numToBytes(0, 1, true), // Message version
	    ...Masternode._numToBytes(0xffffffff, 4, true),
	    ...Crypto.util.hexToBytes(Masternode._decodeIpAddress(ip, port)),
	    ...Masternode._numToBytes(walletPublicKey.length, 1, true),
	    ...walletPublicKey,
	    ...Masternode._numToBytes(mnPublicKey.length, 1, true),
	    ...mnPublicKey,
	    ...Masternode._numToBytes(sigBytes.length, 1, true),
	    ...sigBytes,
	    ...Masternode._numToBytes(sigTime, 8, true),
	    ...Masternode._numToBytes(Masternode._getProtocolVersion(), 4, true),
	    ...Crypto.util.hexToBytes(this.collateralTxId).reverse(),
	    ...Masternode._numToBytes(this.outidx, 4, true),
	    ...Masternode._numToBytes(0, 1, true),
	    ...Masternode._numToBytes(0xffffffff, 4, true),
	    ...Crypto.util.hexToBytes(blockHash).reverse(),
	    ...Masternode._numToBytes(sigTime, 8, true),
	    ...Masternode._numToBytes(sigPingBytes.length, 1, true),
	    ...sigPingBytes,
	    ...Masternode._numToBytes(1, 4, true),
	    ...Masternode._numToBytes(1, 4, true),
	];
	return Crypto.util.bytesToHex(message);
    }

    /**
     * Start the masternode
     * @return {Promise<bool>} Whether or not the message was relayed successfully. This does not necessarely mean
     * starting was successful, but only that the node was able to decode the broadcast.
     */
    async start() {
	const message = await this.broadcastMessageToHex();
	const url = `${cNode.url}/relaymasternodebroadcast?params=${message}`;
	const response = await (await fetch(url)).text();
	return response.includes("Masternode broadcast sent");
    }

    /**
     * @return {Promise<Array>} A list of currently active proposal 
     */
    static async getProposals() {
	const url = `${cNode.url}/getbudgetinfo`;
	return await (await fetch(url)).json();
    }

    /**
     * @param {string} hash - the hash of the proposal to vote
     * @param {number} voteCode - the vote code. "Yes" is 1, "No" is 2
     * @param {number} sigTime - The current time in seconds since UNIX epoch
     * @return {Promise<string>} The signed message used to vote
     */
    async getSignedVoteMessage(hash, voteCode, sigTime) {
	const msg = [
	    ...Crypto.util.hexToBytes(this.collateralTxId).reverse(),
	    ...Masternode._numToBytes(this.outidx, 4, true),
	    // Should be tx sequence, but 0xffffff is fine
	    ...[0, 255, 255, 255, 255],
	    ...Crypto.util.hexToBytes(hash).reverse(),
	    ...Masternode._numToBytes(voteCode, 4, true),
	    ...Masternode._numToBytes(sigTime, 8, true),
	];
	const sha = new jsSHA(0, 0, {numRounds: 2});
	sha.update(msg);
	const [ signature, v ] = await nobleSecp256k1.sign(sha.getHash(0), parseWIF(this.mnPrivateKey, true), { der: false, recovered: true});
	return Crypto.util.bytesToBase64([
	    v + 27, ...signature,
	]);
    }

    /**
     * @param {string} hash - the hash of the proposal to vote
     * @param {number} voteCode - the vote code. "Yes" is 1, "No" is 2
     * @return {Promise<string>} The response from the node
     */
    async vote(hash, voteCode) {
	const sigTime = Math.round(Date.now() / 1000);
	const signature = await this.getSignedVoteMessage(hash, voteCode, sigTime);
	const url = `${cNode.url}/mnbudgetrawvote?params=${this.collateralTxId},${this.outidx},${hash},${voteCode === 1 ? "yes" : "no"},${sigTime},${encodeURI(signature).replaceAll("+", "%2b")}`;
	const text = await (await fetch(url)).text();
	return text;
    }
}

