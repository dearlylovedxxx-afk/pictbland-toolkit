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
test('syntax/version',()=>{assert.doesNotThrow(()=>new Function(s));assert.match(s,/@version\s+0\.3\.51/);assert.match(meta,/@version\s+0\.3\.51/);});
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


test('saved searches are processed strictly top-to-bottom and details start before all searches finish',()=>{
 assert.match(s,/for \(const state of feedStates\) \{/);
 assert.match(s,/state\.processing = true/);
 assert.match(s,/enqueueDetailsForSearchPriority\(state\.priority,generation,target\)/);
 assert.doesNotMatch(s,/await mapLimit\(targets, SEARCH_CONCURRENCY/);
});

test('detail queue prioritizes saved-search order and skips extra render wait when detail tags exist',()=>{
 assert.match(s,/detailQueue\.sort\(\(a,b\) => compareSavedSearchPriority\(a\.work,b\.work\)\)/);
 assert.match(s,/if\(!caption && !\(feedNeedsTagVerification\(\) && tags\.length\)\)/);
 assert.match(s,/detailCaptionFromDoc\(doc,work\) \|\| tagsFrom\(doc\)\.length/);
 assert.match(s,/rows\.map\(\(row,priority\) => \(\{/);
});


test('search-result tag links finish exclusion verification without detail access',()=>{
 assert.match(s,/detailTagsVerified:tags\.length > 0/);
 assert.match(s,/return !feedNeedsTagVerification\(\) \|\| !!work\.detailTagsVerified/);
 assert.match(s,/!work\.detailTagsVerified && !work\.detailLoading/);
 assert.match(s,/work\.detailTagsVerified=tags\.length > 0/);
 assert.doesNotMatch(s,/work\.detailTagsVerified=!!\(caption \|\| tags\.length\)/);
});


test('each saved search is hard-capped at 15 and detail work is globally newest-first',()=>{
 assert.match(s,/const PER_SEARCH_LIMIT = 15;/);
 assert.match(s,/const remaining=Math\.max\(0,PER_SEARCH_LIMIT-state\.loadedIds\.size\)/);
 assert.match(s,/state\.done = state\.loadedIds\.size >= PER_SEARCH_LIMIT \|\| !state\.nextHref/);
 assert.match(s,/detailQueue\.sort\(\(a,b\) => compareNewestWorks\(a\.work,b\.work\)\)/);
 assert.match(s,/older\.hidden=true/);
});
