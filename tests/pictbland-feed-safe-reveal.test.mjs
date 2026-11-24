import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../PictBLand_Novel_Tools.user.js',import.meta.url),'utf8');
const meta=readFileSync(new URL('../PictBLand_Novel_Tools.meta.js',import.meta.url),'utf8');
const begin=s.indexOf('  function allSortedWorks() {'),end=s.indexOf('  async function mapLimit(',begin);
const create=new Function('feedExcludeTags','feedWorks','excludedByTag','compareNewestWorks',s.slice(begin,end)+'return {sortedWorks,feedReviewCandidates};');
const w=(id,tags=[],loaded=false,verified=false,error='')=>({id,tags,detailLoaded:loaded,detailTagsVerified:verified,detailError:error});
function setup(tags,works){
 return create(tags,new Map(works.map(x=>[x.id,x])),x=>x.tags.some(t=>tags.includes(t)),(a,b)=>b.id-a.id);
}
test('syntax/version',()=>{assert.doesNotThrow(()=>new Function(s));assert.match(s,/@version\s+0\.3\.48/);assert.match(meta,/@version\s+0\.3\.48/);});
test('no exclusion means all results visible',()=>{assert.deepEqual(setup([],[w(3),w(2)]).sortedWorks().map(x=>x.id),[3,2]);});
test('blocked/pending/failed/unverified stay hidden',()=>{
 const model=setup(['block'],[w(6,['safe']),w(5,['block']),w(4,['safe'],true,true),w(3,[],false,false,'failed'),w(2,['safe'],true,false),w(1,['safe'],true,true)]);
 assert.deepEqual(model.sortedWorks().map(x=>x.id),[4,1]);
 assert.deepEqual(model.feedReviewCandidates().map(x=>x.id),[6,4,1]);
});
test('only detail-verified results reach card rendering',()=>{
 assert.match(s,/work\.detailTagsVerified=!!\(caption \|\| tags\.length\)/);
 assert.match(s,/if\(feedNeedsTagVerification\(\) && !work\.detailTagsVerified\)/);
 assert.match(s,/observeFeedCards\(feedNeedsTagVerification\(\)\?candidates\.slice\(0,feedVisibleCount\):visible/);
 assert.match(s,/grid\.insertBefore\(existing\|\|createFeedCard\(work\),current\)/);
});
