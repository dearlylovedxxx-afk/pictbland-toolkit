import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const s=readFileSync(new URL('../PictBLand_Novel_Tools.user.js',import.meta.url),'utf8');
const meta=readFileSync(new URL('../PictBLand_Novel_Tools.meta.js',import.meta.url),'utf8');

const begin=s.indexOf('  function allSortedWorks() {');
const end=s.indexOf('  async function mapLimit(',begin);
assert.ok(begin>=0&&end>begin);
const create=new Function(
  'feedExcludeTags','feedWorks','excludedByTag','compareNewestWorks',
  s.slice(begin,end)+'return {sortedWorks,feedReviewCandidates};'
);
const w=(id,tags=[],verified=false,error='')=>({
  id,tags,detailLoaded:verified,detailTagsVerified:verified,detailError:error
});
function setup(tags,works){
  return create(
    tags,
    new Map(works.map(x=>[x.id,x])),
    x=>(x.tags||[]).some(t=>tags.includes(t)),
    (a,b)=>b.id-a.id
  );
}

test('syntax/version',()=>{
  assert.doesNotThrow(()=>new Function(s));
  assert.match(s,/@version\s+0\.3\.54/);
  assert.match(meta,/@version\s+0\.3\.54/);
});

test('no exclusion means results can appear immediately',()=>{
  assert.deepEqual(setup([],[w(3),w(2)]).sortedWorks().map(x=>x.id),[3,2]);
});

test('with exclusions, only tag-verified non-blocked works are visible',()=>{
  const model=setup(['block'],[
    w(6,['safe'],false),
    w(5,['block'],true),
    w(4,['safe'],true),
    w(3,[],false,'detail failed'),
    w(2,['safe'],false),
    w(1,['safe'],true)
  ]);
  assert.deepEqual(model.sortedWorks().map(x=>x.id),[4,1]);
  assert.deepEqual(model.feedReviewCandidates().map(x=>x.id),[6,2]);
});

test('search-result tag links complete exclusion verification without detail access',()=>{
  assert.match(s,/detailTagsVerified:tags\.length > 0/);
  assert.match(s,/return !feedNeedsTagVerification\(\) \|\| !!work\.detailTagsVerified/);
  assert.match(s,/work\.detailTagsVerified=tags\.length > 0/);
  assert.match(s,/if\(!caption && !\(feedNeedsTagVerification\(\) && tags\.length\)\)/);
});

test('each saved search is hard-capped at 15',()=>{
  assert.match(s,/const PER_SEARCH_LIMIT = 15;/);
  assert.match(s,/const remaining=Math\.max\(0,PER_SEARCH_LIMIT-state\.loadedIds\.size\)/);
  assert.match(s,/state\.done = state\.loadedIds\.size >= PER_SEARCH_LIMIT \|\| !state\.nextHref/);
  assert.match(s,/await ensureCoverage\(PER_SEARCH_LIMIT,generation\)/);
  assert.match(s,/older\.hidden=true/);
});

test('detail checks use merged global newest-first order',()=>{
  assert.match(s,/detailQueue\.sort\(\(a,b\) => compareNewestWorks\(a\.work,b\.work\)\)/);
  const ensure=s.slice(s.indexOf('  async function ensureCoverage('),s.indexOf('  async function expandFeed()',s.indexOf('  async function ensureCoverage(')));
  assert.doesNotMatch(ensure,/enqueueDetailsForSearchPriority/);
  assert.match(s,/if\(!feedLoading&&feedOpen\)\s*observeFeedCards/);
});


test('access badges come only from explicit short badge text',()=>{
 assert.match(s,/function accessBadgeLabelsFromText\(value\)/);
 assert.match(s,/function accessBadgesFromDetailDocument\(doc\)/);
 assert.doesNotMatch(s,/const header = titleAt/);
 assert.doesNotMatch(s,/accessBadgesFromCard\(doc\.body/);
 assert.match(s,/Any prose left over means this was not a badge/);
});


test('visibility labels require dedicated visibility/access elements',()=>{
 assert.doesNotMatch(s,/querySelectorAll\?\.\('span,small,strong,em'\)/);
 assert.match(s,/if\(!allowVisibility && !\/\^R18\/\.test\(label\)\)continue/);
 assert.match(s,/\[class\*="visibility" i\]/);
 assert.match(s,/\[class\*="access" i\]/);
 assert.match(s,/work\.accessBadges=\[\.\.\.new Set\(\[\.\.\.ratingBadges,\.\.\.detailRatings,\.\.\.detailVisibility\]\)\]/);
});
