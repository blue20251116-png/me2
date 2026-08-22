const fs = require('fs');
const path = require('path');

const originalJsLoader = require.extensions['.js'];

require.extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (path.basename(filename) !== 'coupangApi.js') {
    return originalJsLoader(mod, filename);
  }

  let source = fs.readFileSync(filename, 'utf8');

  source = source.replace(
    "function accessKeyHash(account) {\n  return crypto.createHash('sha256').update(String(account?.coupang_access_key || '')).digest('hex');\n}",
    "function normalizedCoupangCredentials(account){return {accessKey:String(account?.coupang_access_key||'').trim(),secretKey:String(account?.coupang_secret_key||'').trim()};}\nfunction accessKeyHash(account) {\n  const {accessKey}=normalizedCoupangCredentials(account);\n  return crypto.createHash('sha256').update(accessKey).digest('hex');\n}"
  );

  source = source.replace(
    "  const signature = crypto.createHmac('sha256', account.coupang_secret_key).update(message).digest('hex');\n  return `CEA algorithm=HmacSHA256, access-key=${account.coupang_access_key}, signed-date=${signedDate}, signature=${signature}`;",
    "  const {accessKey,secretKey}=normalizedCoupangCredentials(account);\n  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');\n  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;"
  );

  source = source.replace(
    "    throw err;\n  }\n}\n\nasync function searchProducts",
    "    if(Number(err.response?.status||0)===401){const {accessKey,secretKey}=normalizedCoupangCredentials(account);const fp=crypto.createHash('sha256').update(accessKey).digest('hex').slice(0,8);console.error(`[Coupang][AUTH INVALID] account=${accountId} accessLen=${accessKey.length} secretLen=${secretKey.length} accessFp=${fp} reason=\"${err.response?.data?.message||err.message}\"`);}\n    throw err;\n  }\n}\n\nasync function searchProducts"
  );

  const trimOn = source.includes('normalizedCoupangCredentials(account)');
  const authDiagOn = source.includes('[Coupang][AUTH INVALID]');
  console.log(`[Coupang][SIGNATURE GUARD] trim=${trimOn?'ON':'FAIL'} auth-diagnostic=${authDiagOn?'ON':'FAIL'}`);

  mod._compile(source, filename);
};
