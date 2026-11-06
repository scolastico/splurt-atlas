import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentTarget,deploymentCommands } from '../scripts/deploy-r2.mjs';

test('R2 destination requires an explicit bucket and confines deletion to its prefix',()=>{
 const endpoint='https://account.r2.cloudflarestorage.com';
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:endpoint}),/R2_BUCKET/);
 assert.equal(deploymentTarget({R2_ENDPOINT:endpoint,R2_BUCKET:'splurt-atlas'}).remote,'r2:splurt-atlas/');
 assert.equal(deploymentTarget({R2_ENDPOINT:endpoint+'/bucket/maps',R2_PREFIX:undefined}).remote,'r2:bucket/maps/');
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:endpoint+'/other',R2_BUCKET:'bucket'}),/does not match/);
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:endpoint,R2_BUCKET:'bucket',R2_PREFIX:'../other'}),/Invalid R2_PREFIX/);
 assert.throws(()=>deploymentTarget({R2_ENDPOINT:'http://example.test',R2_BUCKET:'bucket'}),/HTTPS/);
});
test('R2 mirror checks content, removes obsolete objects after transfers, and publishes entry points last',()=>{
 const commands=deploymentCommands('dist','r2:bucket/site/');
 assert.equal(commands[0][0],'copyto');assert.equal(commands[0][2],'r2:bucket/site/data/ATLAS-NOTICE.txt');assert.ok(commands[0].includes('--ignore-times'));
 assert.equal(commands[1][0],'sync');assert.ok(commands[1].includes('--checksum'));assert.ok(commands[1].includes('--delete-after'));
 assert.ok(commands[1].includes('/index.html'));assert.ok(commands[1].includes('/data/manifest.json'));
 assert.equal(commands[2][2],'r2:bucket/site/data/manifest.json');assert.equal(commands[3][2],'r2:bucket/site/index.html');
 assert.ok(commands.every(command=>!command.some(value=>value.includes('secret'))));
});
