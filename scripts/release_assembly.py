#!/usr/bin/env python3
"""Stage exact frozen alpha.3 files into an existing draft. Never delete, retag or publish."""
import argparse, hashlib, http.client, json, os, re, ssl, sys, urllib.error, urllib.parse, urllib.request, zipfile
from pathlib import Path
from apk_delta import apply, digest_file

ROOT=Path(__file__).resolve().parents[1]
PAYLOAD=ROOT/'release-assembly/alpha3'
WORK=ROOT/'.cache/release-assembly'
REPO='Ceaserk01/LocalTavern-Android'
ACTOR='Ceaserk01'
BRANCH='refs/heads/codex/release-assembly'
TAG='v0.1.0-alpha.3'
SOURCE='e557b2515f7c14afa7a9f66abb3cf3edce776e1d'
RELEASE=428768489
ALLOWED_RELEASE_TAGS=(TAG,) # An observed placeholder requires a separate reviewed change.
ASSETS={
 'LocalTavern-0.1.0-alpha.3-arm64.apk':(231491636,'97ff4b3a292829b8047cec129d648db5312c581da43684006ea204df694ba43f'),
 'LocalTavern-0.1.0-alpha.3-x86_64.apk':(233605299,'b53edfc7fe52c77de2ae3d8b85d3a0690c19ff64a33f0f69bdebacb65c19510c'),
 'LocalTavern-0.1.0-alpha.3-source.tar.gz':(38549504,'1edea9d8a7433347a521d2d7ab274caf938a9287959612bff3f7a8c4962087d7'),
 'LocalTavern-0.1.0-alpha.3-manifest.json':(3005,'dd80eb6f1c54715f7f493a6e0c42446b448f479ab76b34c4e6c6b91e8033eec3'),
 'LocalTavern-0.1.0-alpha.3-validation.json':(12517,'0840f4dcb29718322f7f6cdac4bf5134ede41761797a1c077da14e841ca08433'),
 'SHA256SUMS.txt':(698,'38425de4627cf96bb27b8c348db843f55e3a0b18f2536f5a448a08e4cbd57b30'),
 'signature-arm64.txt':(957,'770b6705f0d2023c63f6dd23d90983a0e6109f6cd4bb799f50b2ec0b92f66123'),
 'signature-x86_64.txt':(957,'770b6705f0d2023c63f6dd23d90983a0e6109f6cd4bb799f50b2ec0b92f66123'),
}
PATCHES={
 'arm64':{'baseBytes':231485075,'baseSha':'a3722046212986c1962ed8e3083148931208b4418464570d795c74a67ec1fe15','patchBytes':1180839,'patchSha':'12e1a41a909617a2886b7b7d3f244d2fe32d410bc54140169ac2f077abb3cc81'},
 'x86_64':{'baseBytes':233598755,'baseSha':'5a94509eae28a5e75011abd2963e4679c2f8e2509f9fb4bdeb3c5d087af1e0ec','patchBytes':1180895,'patchSha':'115f5013b77e68850369933ef94e664b6b88d0f79b7ce9d2bece051ccd570ec1'},
}
class Failure(Exception):pass
class NoAuthenticatedRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise Failure('AUTHENTICATED_API_REDIRECT_REFUSED')
def require(condition,code):
 if not condition:raise Failure(code)
def bounded(value):return re.sub(r'[\x00-\x1f\x7f]','?',str(value))[:160]
def verify_file(file,size,sha):
 require(file.is_file() and not file.is_symlink(),'PAYLOAD_FILE_MISSING_OR_SYMLINK')
 require(file.stat().st_size==size and digest_file(file)==sha,'PAYLOAD_DIGEST_MISMATCH')
def verify_payload():
 for name,(size,sha) in ASSETS.items():
  if not name.endswith('.apk'):verify_file(PAYLOAD/name,size,sha)
 for abi,value in PATCHES.items():
  patch=PAYLOAD/f'alpha2-to-alpha3-{abi}.ltpatch';verify_file(patch,value['patchBytes'],value['patchSha'])
  with zipfile.ZipFile(patch) as z:
   require(sorted(x.filename for x in z.infolist())==['literal.bin','manifest.json'],'PATCH_ENTRIES')
   require(z.getinfo('manifest.json').file_size<=16*1024*1024,'PATCH_MANIFEST_LIMIT')
   m=json.loads(z.read('manifest.json'))
  target=f'LocalTavern-0.1.0-alpha.3-{abi}.apk'
  require(m['baseName']==f'LocalTavern-0.1.0-alpha.2-{abi}.apk' and m['targetName']==target and m['baseSha256']==value['baseSha'] and m['targetSha256']==ASSETS[target][1] and m['baseBytes']==value['baseBytes'] and m['targetBytes']==ASSETS[target][0],'PATCH_IDENTITY')

class Publisher:
 def __init__(self,token,report):self.token=token;self.report=report
 def api(self,path):
  require(path.startswith('/repos/'+REPO+'/'),'API_PATH_NOT_ALLOWED')
  req=urllib.request.Request('https://api.github.com'+path,headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json','User-Agent':'LocalTavern-frozen-release-assembly','X-GitHub-Api-Version':'2022-11-28'})
  try:
   with urllib.request.build_opener(NoAuthenticatedRedirect()).open(req,timeout=30) as response:
    data=response.read(2*1024*1024+1);require(len(data)<=2*1024*1024,'API_RESPONSE_LIMIT');return json.loads(data)
  except urllib.error.HTTPError as error:raise Failure('API_HTTP_'+str(error.code)) from None
 def preflight(self):
  ref=self.api('/repos/'+REPO+'/git/ref/tags/'+TAG)
  object=ref.get('object',{});seen=set()
  for depth in range(5):
   if object.get('type')=='commit':break
   sha=object.get('sha','')
   require(depth<4 and object.get('type')=='tag' and re.fullmatch(r'[a-f0-9]{40}',sha) and sha not in seen,'INVALID_OR_CYCLIC_TAG_CHAIN')
   seen.add(sha);object=self.api('/repos/'+REPO+'/git/tags/'+sha).get('object',{})
  require(object.get('type')=='commit' and object.get('sha')==SOURCE,'FROZEN_TAG_CHANGED')
  release=self.api(f'/repos/{REPO}/releases/{RELEASE}')
  self.report['preflight']={'releaseId':release.get('id'),'draft':release.get('draft'),'tagName':bounded(release.get('tag_name')),'targetCommitish':bounded(release.get('target_commitish')),'name':bounded(release.get('name')),'sourceTagRefType':bounded(ref.get('object',{}).get('type')),'resolvedSourceTagSha':object['sha']}
  require(release.get('id')==RELEASE and release.get('draft') is True,'EXISTING_DRAFT_REQUIRED')
  require(release.get('tag_name') in ALLOWED_RELEASE_TAGS,'DRAFT_TAG_MISMATCH_NO_WRITES')
  require('0.1.0-alpha.3' in str(release.get('name','')),'DRAFT_TITLE_MISMATCH')
  target=release.get('target_commitish')
  if target==SOURCE or target==TAG:pass
  elif target=='codex/compatibility-performance':
   branch=self.api('/repos/'+REPO+'/git/ref/heads/codex/compatibility-performance')
   require(branch.get('object',{}).get('type')=='commit' and branch['object']['sha']==SOURCE,'DRAFT_SOURCE_BRANCH_CHANGED')
  else:raise Failure('DRAFT_SOURCE_MISMATCH_NO_WRITES')
  expected=f'https://uploads.github.com/repos/{REPO}/releases/{RELEASE}/assets'
  require(release.get('upload_url','').split('{',1)[0]==expected,'UPLOAD_URL_MISMATCH')
  return release
 def assets(self):
  result=[]
  for page in range(1,11):
   entries=self.api(f'/repos/{REPO}/releases/{RELEASE}/assets?per_page=100&page={page}')
   require(isinstance(entries,list),'ASSET_LIST_FORMAT');result.extend(entries)
   if len(entries)<100:return result
  raise Failure('ASSET_LIST_LIMIT')
 def inspect(self,name,assets):
  entries=[x for x in assets if x.get('name')==name]
  if not entries:return {'name':name,'status':'missing'}
  size,sha=ASSETS[name]
  valid=len(entries)==1 and entries[0].get('state')=='uploaded' and entries[0].get('size')==size and entries[0].get('digest')=='sha256:'+sha
  return {'name':name,'status':'verified-existing' if valid else 'deferred-existing-pending-or-unverified','assets':[{'id':x.get('id'),'state':bounded(x.get('state')),'size':x.get('size'),'digest':bounded(x.get('digest'))} for x in entries]}
 def download_base(self,abi):
  value=PATCHES[abi];name=f'LocalTavern-0.1.0-alpha.2-{abi}.apk';file=WORK/name
  if file.exists():verify_file(file,value['baseBytes'],value['baseSha']);return file
  url=f'https://github.com/{REPO}/releases/download/v0.1.0-alpha.2/{name}'
  # Public download deliberately gets no Authorization header or job token.
  h=hashlib.sha256();count=0;created=False
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'LocalTavern-frozen-release-assembly'}),timeout=60) as source,file.open('xb') as output:
    created=True
    for block in iter(lambda:source.read(1024*1024),b''):
     count+=len(block);require(count<=value['baseBytes'],'BASE_DOWNLOAD_SIZE');h.update(block);output.write(block)
   require(count==value['baseBytes'] and h.hexdigest()==value['baseSha'],'BASE_DOWNLOAD_DIGEST')
  except Exception:
   if created:file.unlink(missing_ok=True)
   raise
  return file
 def local_file(self,name):
  size,sha=ASSETS[name]
  if not name.endswith('.apk'):return PAYLOAD/name
  abi='arm64' if name.endswith('-arm64.apk') else 'x86_64';value=PATCHES[abi];output=WORK/name
  if not output.exists():
   base=self.download_base(abi)
   apply(base,PAYLOAD/f'alpha2-to-alpha3-{abi}.ltpatch',output,value['baseSha'],sha,value['patchSha'])
  verify_file(output,size,sha);return output
 def upload(self,name,file):
  require(name in ASSETS,'ASSET_NAME_NOT_ALLOWED');size,sha=ASSETS[name];verify_file(file,size,sha)
  connection=http.client.HTTPSConnection('uploads.github.com',timeout=120,context=ssl.create_default_context())
  try:
   path=f'/repos/{REPO}/releases/{RELEASE}/assets?'+urllib.parse.urlencode({'name':name})
   connection.putrequest('POST',path)
   for key,value in {'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json','User-Agent':'LocalTavern-frozen-release-assembly','Content-Type':'application/octet-stream','Content-Length':str(size),'X-GitHub-Api-Version':'2022-11-28'}.items():connection.putheader(key,value)
   connection.endheaders()
   with file.open('rb') as stream:
    for block in iter(lambda:stream.read(1024*1024),b''):connection.send(block)
   response=connection.getresponse();body=response.read(2*1024*1024+1)
   require(len(body)<=2*1024*1024,'UPLOAD_RESPONSE_LIMIT')
   if response.status!=201:return {'httpStatus':response.status,'requiresReadback':True}
   asset=json.loads(body)
   require(asset.get('name')==name,'UPLOAD_NAME_MISMATCH')
   return {'httpStatus':201,'assetId':asset.get('id'),'requiresReadback':True}
  except (OSError,TimeoutError,http.client.HTTPException):return {'uploadAcknowledgementUnknown':True,'requiresReadback':True}
  finally:connection.close()
 def run(self,arm_mode):
  self.preflight()
  for name in ASSETS:
   self.preflight();state=self.inspect(name,self.assets())
   if state['status']!='missing':self.report['steps'].append(state);continue
   if name.endswith('-arm64.apk') and arm_mode=='defer':
    self.report['steps'].append({'name':name,'status':'deferred-browser-arm-upload-may-be-live'});continue
   file=self.local_file(name)
   # Re-check after reconstruction/download: absence earlier never authorizes replacement.
   self.preflight();state=self.inspect(name,self.assets())
   if state['status']!='missing':self.report['steps'].append(state);continue
   response=self.upload(name,file)
   state=self.inspect(name,self.assets());state['uploadObservation']=response;self.report['steps'].append(state)
  current=self.assets();self.report['finalAssets']=[self.inspect(name,current) for name in ASSETS]
  self.report['unexpectedAssets']=[{'id':x.get('id'),'name':bounded(x.get('name')),'state':bounded(x.get('state'))} for x in current if x.get('name') not in ASSETS]
  self.report['allFrozenAssetsVerified']=all(x['status']=='verified-existing' for x in self.report['finalAssets'])
  self.report['readyForOwnerPublication']=self.report['allFrozenAssetsVerified'] and not self.report['unexpectedAssets']
  self.report['publishedByThisJob']=False

def main():
 parser=argparse.ArgumentParser(description=__doc__);mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--verify-payload',action='store_true');mode.add_argument('--publish',action='store_true');args=parser.parse_args()
 report={'repository':REPO,'releaseId':RELEASE,'frozenSourceTag':TAG,'frozenSourceCommit':SOURCE,'steps':[],'publishedByThisJob':False}
 WORK.mkdir(parents=True,exist_ok=True)
 try:
  verify_payload();report['localPayloadVerified']=True
  if args.publish:
   require(os.environ.get('GITHUB_REPOSITORY','').casefold()==REPO.casefold() and os.environ.get('GITHUB_ACTOR','').casefold()==ACTOR.casefold(),'REPOSITORY_OR_ACTOR_NOT_ALLOWED')
   require(os.environ.get('GITHUB_REF')==BRANCH and os.environ.get('GITHUB_EVENT_NAME')=='push' and os.environ.get('GITHUB_SERVER_URL')=='https://github.com','BRANCH_OR_EVENT_NOT_ALLOWED')
   trigger=os.environ.get('GITHUB_TRIGGERING_ACTOR',ACTOR);require(trigger.casefold()==ACTOR.casefold(),'TRIGGERING_ACTOR_NOT_ALLOWED')
   token=os.environ.get('GITHUB_TOKEN','');require(token and '\r' not in token and '\n' not in token,'TEMPORARY_JOB_TOKEN_REQUIRED')
   arm_mode=os.environ.get('ARM_MODE','defer');require(arm_mode in ('defer','allow'),'INVALID_ARM_MODE');report['armMode']=arm_mode
   Publisher(token,report).run(arm_mode)
  report['operationSucceeded']=True
 except Failure as error:report['operationSucceeded']=False;report['errorCode']=str(error)
 except Exception:report['operationSucceeded']=False;report['errorCode']='UNEXPECTED_INFRASTRUCTURE_FAILURE'
 (WORK/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
 return 0 if report['operationSucceeded'] else 1
if __name__=='__main__':sys.exit(main())
