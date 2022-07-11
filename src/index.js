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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const tslog_1 = require("tslog");
const ledger_1 = __importDefault(require("./ledger"));
const manager_1 = __importDefault(require("./manager"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const log = new tslog_1.Logger();
const localUrl = process.env.LOCAL_LEDGER_URL || 'https://develop.m10.net';
const remoteUrl = process.env.REMOTE_LEDGER_URL || 'https://develop.m10.net';
const localAccountId = process.env.LOCAL_ACCOUNT_ID || '';
const remoteAccountId = process.env.REMOTE_ACCOUNT_ID || '';
const localKeyPair = process.env.localKeyPair || './local.pkcs8';
const remoteKeyPair = process.env.remoteKeyPair || './remote.pkcs8';
const startService = () => __awaiter(void 0, void 0, void 0, function* () {
    // Create a connection to the local M10 ledger
    const localLedger = new ledger_1.default(localUrl, localAccountId, localKeyPair);
    log.info(`Connecting to Local M10 ledger ${localLedger}`);
    // Create a connection to the remote M10 ledger
    const remoteLedger = new ledger_1.default(remoteUrl, remoteAccountId, remoteKeyPair);
    log.info(`Connecting to Remote M10 ledger ${remoteLedger}`);
    // Create the conditional payment manager
    const app = new manager_1.default(log, localLedger, remoteLedger);
    log.info('Created conditional payment manager');
    const signalTraps = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
    signalTraps.forEach(type => {
        process.once(type, () => __awaiter(void 0, void 0, void 0, function* () {
            log.info(`process.once ${type}`);
            app.close();
        }));
    });
    // Run manager
    log.info('Running conditional payment manager');
    yield app.run();
});
startService();
