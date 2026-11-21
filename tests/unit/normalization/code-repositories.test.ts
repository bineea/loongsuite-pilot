import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodeChangeProcessor } from '../../../src/normalization/code-change-processor.js';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await fs.rm(d,{recursive:true,force:true});});
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:'pipe'}).trim();
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'code-repos-'));dirs.push(root);const a=path.join(root,'a'),b=path.join(root,'b');for(const d of [a,b]){await fs.mkdir(d);git(d,'init');}git(a,'remote','add','origin','https://user:secret@example.com/team/a.git');git(b,'remote','add','origin','git@example.com:team/b.git');return{root,a,b};}
const diff={type:'update',unified_diff:'@@ -1 +1,2 @@\n-old\n+new\n+extra\n'};
function entry(changes:object,cwd:string){return buildAgentActivityEntry({'event.name':'tool.result','gen_ai.agent.type':'codex','gen_ai.session.id':'s','gen_ai.tool.call.id':'c','gen_ai.tool.name':'codex_file_change','tool.result.status':'success','workspace.path':cwd,'gen_ai.tool.call.result':{changes} as any});}
it('跨仓库按文件拆分，保留总计，不根据会话目录错误归类',async()=>{
 const {root,a,b}=await fixture();const e=entry({[path.join(a,'x.ts')]:diff,[path.join(b,'y.ts')]:diff},root);
 const p=new CodeChangeProcessor();p.enrich([e]);await (p as any).enrichRepositories([e]);
 expect(e['gen_ai.code.lines_added']).toBe(4);expect(e['gen_ai.code.lines_deleted']).toBe(2);
 expect(e['gen_ai.code.repositories']).toEqual([
  {id:'remote:example.com/team/a',name:'example.com/team/a',added:2,deleted:1,files:1},
  {id:'remote:example.com/team/b',name:'example.com/team/b',added:2,deleted:1,files:1},
 ]);
 expect(JSON.stringify(e)).not.toContain('secret');expect(JSON.stringify(e)).not.toContain('unified_diff');
});
it('同一远端不同协议的副本合并，本地无远端 worktree 使用共同身份',async()=>{
 const {root,a,b}=await fixture();git(b,'remote','set-url','origin','ssh://git@example.com/team/a.git');
 const p=new CodeChangeProcessor();const e=entry({[path.join(a,'x')]:diff,[path.join(b,'y')]:diff},root);p.enrich([e]);await (p as any).enrichRepositories([e]);
 expect(e['gen_ai.code.repositories']).toEqual([{id:'remote:example.com/team/a',name:'example.com/team/a',added:4,deleted:2,files:2}]);
 git(a,'remote','remove','origin');git(a,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','init');
 const work=path.join(root,'worktree');git(a,'worktree','add','-b','test-branch',work);
 const {resolveCodeRepository}=await import('../../../src/normalization/code-repositories.js');
 // 新目录避免上一条远端信息的短期缓存。
 await fs.mkdir(path.join(a,'new'));await fs.mkdir(path.join(work,'new'));
 const first=await resolveCodeRepository(path.join(a,'new','x'),root);const second=await resolveCodeRepository(path.join(work,'new','x'),root);
 expect(first.id).toMatch(/^local:/);expect(first).toEqual(second);
});
it('相对路径使用工作区，非仓库文件保持未知，失败不产生分项',async()=>{
 const {root,a}=await fixture();const p=new CodeChangeProcessor();const e=entry({'nested/file.ts':diff,[path.join(root,'outside.ts')]:diff},a);
 p.enrich([e]);await (p as any).enrichRepositories([e]);
 expect(e['gen_ai.code.repositories']).toEqual(expect.arrayContaining([{id:'unknown',name:'',added:2,deleted:1,files:1},{id:'remote:example.com/team/a',name:'example.com/team/a',added:2,deleted:1,files:1}]));
 const failed=entry({[path.join(a,'x')]:diff},a);failed['tool.result.status']='error';p.enrich([failed]);await (p as any).enrichRepositories([failed]);expect(failed['gen_ai.code.repositories']).toBeUndefined();
});
it('同主机相同仓库路径的不同非默认 SSH 端口不合并',async()=>{
 const {root,a,b}=await fixture();git(a,'remote','set-url','origin','ssh://git@example.com:443/team/a.git');git(b,'remote','set-url','origin','ssh://git@example.com/team/a.git');
 const {resolveCodeRepository}=await import('../../../src/normalization/code-repositories.js');
 const first=await resolveCodeRepository(path.join(a,'x'),root),second=await resolveCodeRepository(path.join(b,'y'),root);
 expect(first.id).toBe('remote:example.com:443/team/a');expect(second.id).toBe('remote:example.com/team/a');
});
it('Claude 的成功 Edit 与 Write 使用实际路径，apply_patch 保留调用时工作区',async()=>{
 const {root,a,b}=await fixture();const p=new CodeChangeProcessor();
 const make=(event:'tool.call'|'tool.result',id:string,extra:object)=>buildAgentActivityEntry({'event.name':event,'gen_ai.agent.type':'claude-code','gen_ai.session.id':'s','gen_ai.tool.call.id':id,'workspace.path':root,...extra});
 const edit=make('tool.result','edit',{'gen_ai.tool.name':'Edit','tool.result.status':'success','gen_ai.tool.call.result':{filePath:path.join(a,'x'),structuredPatch:[{lines:['-old','+new']}]}});
 const writeCall=make('tool.call','write',{'gen_ai.tool.name':'Write','workspace.path':b,'gen_ai.tool.call.arguments':{file_path:'y',content:'new\n'}});
 const write=make('tool.result','write',{'gen_ai.tool.name':'Write','tool.result.status':'success','gen_ai.tool.call.result':{type:'create',content:'new\n'}});
 const call=make('tool.call','patch',{'gen_ai.tool.name':'apply_patch','workspace.path':a,'gen_ai.tool.call.arguments':'*** Begin Patch\n*** Update File: z\n@@\n-old\n+new\n*** End Patch'});
 const result=make('tool.result','patch',{'gen_ai.tool.name':'apply_patch','workspace.path':b,'gen_ai.tool.call.result':'Success. Updated the following files:\nM z'});
 p.enrich([edit,writeCall,write,call,result]);await p.enrichRepositories([edit,write,result]);
 expect(edit['gen_ai.code.repositories']).toEqual([{id:'remote:example.com/team/a',name:'example.com/team/a',added:1,deleted:1,files:1}]);
 expect(write['gen_ai.code.repositories']).toEqual([{id:'remote:example.com/team/b',name:'example.com/team/b',added:1,deleted:0,files:1}]);
 expect(result['gen_ai.code.repositories']).toEqual([{id:'remote:example.com/team/a',name:'example.com/team/a',added:1,deleted:1,files:1}]);
});
