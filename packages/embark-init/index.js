/* global exports process require */

const {join} = require('path');
const {promisify} = require('util');

const dappPath = process.env.DAPP_PATH || process.cwd();

const green = (text) => '\x1b[32m' + text + '\x1b[0m';

exports.init = async ({
  doneMessage = green('init done!'),
} = {}) => {
  console.log(doneMessage);
};
