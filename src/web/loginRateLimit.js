'use strict';
const attempts = new Map();
module.exports = function loginRateLimit(req,res,next) {
  const key=String(req.ip||'unknown');
  const now=Date.now();
  if (attempts.size>10000) for(const [ip,row] of attempts) if(row.until<=now) attempts.delete(ip);
  let row=attempts.get(key);
  if(!row || row.until<=now) {row={count:0,until:now+15*60000};attempts.set(key,row);}
  if(++row.count>30) {res.set('Retry-After',String(Math.ceil((row.until-now)/1000)));return res.status(429).json({error:'로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'});}
  next();
};
