import { Logger } from 'tslog';
import M10Ledger from './ledger';
import PaymentManager from './manager';
import dotenv from 'dotenv';

dotenv.config();

const log: Logger = new Logger({ displayFilePath: 'hidden' });

const localId = process.env.LOCAL_ID || 'usd.m10';
const remoteId = process.env.REMOTE_ID || 'idr.m10';
const localUrl = process.env.LOCAL_LEDGER_URL || 'develop.m10.net';
const remoteUrl = process.env.REMOTE_LEDGER_URL || 'develop.m10.net';
const localAccountId = process.env.LOCAL_ACCOUNT_ID || '00000000000000000000000000000000'; // USD root @ develop
const remoteAccountId = process.env.REMOTE_ACCOUNT_ID || '04000000000000000000000000000000'; // EUR root @ develop
const localKeyPair =
  process.env.localKeyPair || 'MFMCAQEwBQYDK2VwBCIEIGnCNU8553Jq7aqK0zq+2YqED38MxGq4pA83mGCaDiIvoSMDIQA9E2FOITuigkjnsEK1+ggtsW8gsB1vgFNQi24Wfxr1dg==';
const remoteKeyPair =
  process.env.remoteKeyPair || 'MFMCAQEwBQYDK2VwBCIEIHRU82MbNQwjc5hzNSL4+b1bhfswNuz34d3mW21Z8Yk2oSMDIQDu9uAH9WKNkpHrNzyIihEdkZK2dZM31Gyep94Na+RGew==';

const startService = async () => {
  // Create a connection to the local M10 ledger
  const localLedger = new M10Ledger(localId, localUrl, localAccountId, localKeyPair);

  // Create a connection to the remote M10 ledger
  const remoteLedger = new M10Ledger(remoteId, remoteUrl, remoteAccountId, remoteKeyPair);

  // Create the conditional payment manager
  const app = new PaymentManager(log, localLedger, remoteLedger);

  const signalTraps: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
  signalTraps.forEach(type => {
    process.once(type, async () => {
      log.info(`process.once ${type}`);
      app.close();
    });
  });

  // Run manager
  log.info('Running conditional payment manager');
  await app.run();
  log.info('Done');
};

startService();
