import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive=promisify(scrypt);
export async function hashPassword(password:string){const salt=randomBytes(16).toString('hex');const key=await derive(password,salt,64) as Buffer;return `scrypt$${salt}$${key.toString('hex')}`;}
export async function verifyPassword(password:string,stored:string){
 if(/^[a-f0-9]{32}$/.test(stored)){const digest=createHash('md5').update('ZDAN-GHN'+password).digest();return timingSafeEqual(digest,Buffer.from(stored,'hex'));}
 const match=/^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored);if(!match)return false;
 const [,salt,hex]=match;
 const derived=await derive(password,salt,64) as Buffer;return timingSafeEqual(derived,Buffer.from(hex,'hex'));
}
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
