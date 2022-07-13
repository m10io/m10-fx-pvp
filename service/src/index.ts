import { Logger } from 'tslog';
import M10Ledger from './ledger';
import PaymentManager from './manager';
import dotenv from 'dotenv';

dotenv.config();

const log: Logger = new Logger({ displayFilePath: 'hidden' });

const localOperator = process.env.LOCAL_OPERATOR || 'm10';
const remoteOperator = process.env.LOCAL_OPERATOR || 'm10';
const localUrl = process.env.LOCAL_LEDGER_URL || 'lowgum.m10.net';
const remoteUrl = process.env.REMOTE_LEDGER_URL || 'lowgum.m10.net';
const localAccountId = process.env.LOCAL_ACCOUNT_ID || '00000000000000000000000000000000'; // USD root @ develop
const remoteAccountId = process.env.REMOTE_ACCOUNT_ID || '04000000000000000000000000000000'; // EUR root @ develop
const localKeyPair =
  process.env.LOCAL_KEY_PAIR ||
  'MFMCAQEwBQYDK2VwBCIEIPTfjmouJ351G6zHdRRqzvGKPamXNjFb5cIVBN0MmqLAoSMDIQDNiOnzUfVHzu0nUeNeiqR5xXZ6j5YYFL4OWmgeG6qqKQ=='; // Bank admin
const remoteKeyPair =
  process.env.REMOTE_KEY_PAIR ||
  'MFMCAQEwBQYDK2VwBCIEIPTfjmouJ351G6zHdRRqzvGKPamXNjFb5cIVBN0MmqLAoSMDIQDNiOnzUfVHzu0nUeNeiqR5xXZ6j5YYFL4OWmgeG6qqKQ=='; // Bank admin

const startService = async () => {
  // Create a connection to the local M10 ledger
  const localLedger = new M10Ledger(localOperator, localUrl, localAccountId, localKeyPair);

  // Create a connection to the remote M10 ledger
  const remoteLedger = new M10Ledger(remoteOperator, remoteUrl, remoteAccountId, remoteKeyPair);

  // Create the conditional payment manager for Ledger A (~local)
  const localManager = new PaymentManager(localLedger, remoteLedger);

  // Create the conditional payment manager for Ledger B (~remote)
  const remoteManager = new PaymentManager(remoteLedger, localLedger);

  const signalTraps: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
  signalTraps.forEach(type => {
    process.once(type, async () => {
      log.info(type);
      localManager.close();
      remoteLedger.close();
    });
  });

  // Run manager
  log.info('Running conditional payment managers in parallel');
  await Promise.race([localManager.run(), remoteManager.run()]);
  log.info('Done');
};

startService();
