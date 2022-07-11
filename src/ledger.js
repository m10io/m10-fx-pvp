"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("m10-sdk/out/client");
const utils_1 = require("m10-sdk/out/utils");
class M10Ledger {
    constructor(url, accountId, keyPair) {
        this.client = new client_1.LedgerClient(url, true);
        this.accountId = accountId;
        this.keyPair = utils_1.CryptoSigner.getSignerFromPkcs8V1(keyPair);
    }
    observeTransfer(onData) {
        return __awaiter(this, void 0, void 0, function* () {
            const [service, start] = this.client.getObserveTransfers(this.keyPair, {
                involvedAccounts: [Uint8Array.from(Buffer.from(this.accountId, 'hex'))],
            });
            service.on('data', onData);
            start();
        });
    }
}
exports.default = M10Ledger;
