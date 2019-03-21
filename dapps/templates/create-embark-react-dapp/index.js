#!/usr/bin/env node

/* global __dirname process require */

require('colors');
var fs = require('fs');
var path = require('path');
var semver = require('semver');

function cyan(str) { return str.cyan; }

function log(mark, str, which) {
  var _which = which || 'log';
  console[_which](mark, str.filter(function (s) { return !!s; }).join(' '));
}

function logError() {
  var str = Array.prototype.slice.call(arguments);
  log(('✘').red, str, 'error');
}

var pkgJson = require(path.join(__dirname, 'package.json'));
var procVer = semver.clean(process.version);
var range = pkgJson.runtime.engines.node;
if (!semver.satisfies(procVer, pkgJson.runtime.engines.node)) {
  logError(
    'node version ' + procVer + ' is not supported, please use version ' + range
  );
  process.exit(1);
}

if (!['build/package.json', 'build-demo/package.json', 'dist/index.js']
    .every(function (file) {
      return fs.existsSync(path.join(__dirname, file));
    })) {
  // eslint-disable-next-line no-path-concat
  var inside = ' in ' + __dirname;
  if (fs.existsSync(path.join(
    __dirname, '../../../dapps/templates/create-embark-react-dapp'
  ))) {
    inside = ' inside the monorepo';
  }
  logError('missing build for package ' + cyan(pkgJson.name) + inside);
  process.exit(1);
}

require(path.join(__dirname, 'dist/index'));
