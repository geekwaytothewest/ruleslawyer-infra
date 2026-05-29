#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EnvName, envConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ServicesStack } from '../lib/services-stack';

const app = new cdk.App();

const envName = (app.node.tryGetContext('env') ?? 'nonprod') as EnvName;
const config = envConfig[envName];
const env = { account: config.account, region: config.region };
const id = (name: string) => `geekway-${envName}-${name}`;

const network = new NetworkStack(app, id('network'), { env, envName, config });

const data = new DataStack(app, id('data'), {
  env,
  envName,
  config,
  vpc: network.vpc,
  dbSg: network.dbSg,
});

new ServicesStack(app, id('services'), {
  env,
  envName,
  config,
  vpc: network.vpc,
  ecsSg: network.ecsSg,
  httpsListener: network.httpsListener,
  dbSecret: data.dbSecret,
  spaBucket: network.spaBucket,
  distribution: network.distribution,
});

app.synth();
