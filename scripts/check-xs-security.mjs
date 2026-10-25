#!/usr/bin/env node
// Check that xs-security.json still grants what the code checks for. calmcp admits an HTTP caller
// with the Viewer scope and offers calm_create only with Writer (src/server.ts); a renamed or
// dropped scope in the descriptor would only show on BTP, as every user being refused. Also checks
// that role templates and role collections reference names that exist, and that XSUAA only
// returns sign-ins to calmcp's own callback: a host wildcard such as https://*.hana.ondemand.com/**
// would hand the authorization code to any app on the shared domain.
//
// Usage: node scripts/check-xs-security.mjs

import { readFileSync } from 'node:fs';

const descriptor = JSON.parse(readFileSync('xs-security.json', 'utf8'));
const server = readFileSync('src/server.ts', 'utf8');
const problems = [];

/** A scope constant from src/server.ts, e.g. VIEWER_SCOPE = 'Viewer'. */
function scopeConstant(name) {
  const match = server.match(new RegExp(`${name} = '([^']+)'`));
  if (!match) problems.push(`src/server.ts no longer defines ${name}`);
  return match?.[1];
}

const scopes = new Set((descriptor.scopes ?? []).map((scope) => scope.name));
for (const constant of ['VIEWER_SCOPE', 'WRITER_SCOPE']) {
  const local = scopeConstant(constant);
  if (local && !scopes.has(`$XSAPPNAME.${local}`)) {
    problems.push(`${constant} is '${local}', but xs-security.json has no $XSAPPNAME.${local}`);
  }
}

const templates = new Set();
for (const template of descriptor['role-templates'] ?? []) {
  templates.add(`$XSAPPNAME.${template.name}`);
  for (const reference of template['scope-references'] ?? []) {
    if (!scopes.has(reference)) {
      problems.push(`role template ${template.name} references unknown scope ${reference}`);
    }
  }
}

for (const collection of descriptor['role-collections'] ?? []) {
  for (const reference of collection['role-template-references'] ?? []) {
    if (!templates.has(reference)) {
      problems.push(`role collection ${collection.name} references unknown template ${reference}`);
    }
  }
}

// Loopback is the only host a redirect URI may leave open; the deployed route comes from mta.yaml.
const loopback = /^http:\/\/localhost:\*\/oauth\/callback$/;
const mta = readFileSync('mta.yaml', 'utf8');
const redirects = [
  ...(descriptor['oauth2-configuration']?.['redirect-uris'] ?? []),
  ...[...mta.matchAll(/^\s*- ((?:~\{|[a-z]+:\/\/)\S*)$/gm)].map((match) => match[1]),
];
for (const uri of redirects) {
  if (uri.includes('*') && !loopback.test(uri)) {
    problems.push(`redirect URI ${uri} has a wildcard; list the exact /oauth/callback URL`);
  } else if (!uri.endsWith('/oauth/callback')) {
    problems.push(`redirect URI ${uri} is not an /oauth/callback URL`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log(
  `✓ xs-security.json: ${scopes.size} scopes, ${templates.size} role templates, ` +
    `${(descriptor['role-collections'] ?? []).length} role collections, all references resolve, ` +
    `${redirects.length} exact redirect URIs`,
);
