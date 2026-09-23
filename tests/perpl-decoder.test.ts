import {describe,it,expect} from 'vitest'
import {PerplStateStore,decodeTradingMessage} from '../packages/perpl/src/decoder.js'
const account={id:1,in:1,fr:false,fw:true,ft:0,lfr:44,b:'100000000',lb:'0'}
const wallet={mt:19,sn:9,addr:'wallet',as:[account]}
const position=(pid:number,s=100)=>({pid,acc:1,mkt:1,st:1,sd:1,c:'1000000',ep:100,s,lv:500,at:{b:1,t:1000}})
describe('Perpl protocol state',()=>{
 it('reads account baseline from the actual top-level wallet snapshot',()=>{const state=new PerplStateStore();state.apply(wallet);expect(state.requestIdBaseline(1)).toBe(44)})
 it('requires all snapshots and a fresh heartbeat before readiness',()=>{const state=new PerplStateStore();state.apply(wallet,1000);expect(state.ready(1000)).toBe(false);state.apply({mt:23,d:[]});state.apply({mt:26,d:[]});expect(state.ready(1000)).toBe(false);state.apply({mt:100,sn:10},1000);expect(state.ready(1000)).toBe(true)})
 it('merges delta positions without losing other positions and records WS receipt time',()=>{const state=new PerplStateStore();state.apply(wallet);state.apply({mt:26,d:[position(1),position(2)]},1_000);state.apply({mt:27,d:[{...position(1,50),at:{b:2,t:2000}}]},2_000);expect(state.snapshot().positions.map(p=>p.s)).toEqual([50,100]);expect(state.positionSnapshot(1,1,1)).toMatchObject({position:{s:50},observedAt:2_000});state.apply({mt:27,d:[position(1,200)]},3_000);expect(state.snapshot().positions[0].s).toBe(50);expect(state.positionSnapshot(1,1,1)?.observedAt).toBe(2_000)})
 it('uses heartbeat sequence rules, not contiguous command status sequence',()=>{const state=new PerplStateStore();state.apply(wallet);state.apply({mt:3,sn:500,cid:1,status:{code:0}});expect(state.apply({mt:100,sn:10}).accepted).toBe(true);expect(state.apply({mt:100,sn:12}).accepted).toBe(false)})
 it('rejects malformed input and missing initial account',()=>{expect(()=>decodeTradingMessage(null)).toThrow();expect(()=>new PerplStateStore().requestIdBaseline()).toThrow()})
})
