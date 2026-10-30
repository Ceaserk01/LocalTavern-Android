#!/usr/bin/env python3
"""Exact signed-APK copy/literal delta, Python stdlib only."""
import argparse, hashlib, io, json, os, struct, zipfile
from pathlib import Path

SCHEMA='local-tavern-apk-copy-literal-v1'
CHUNK=1024*1024

def digest_file(file):
 h=hashlib.sha256()
 with Path(file).open('rb') as stream:
  for block in iter(lambda:stream.read(CHUNK),b''):h.update(block)
 return h.hexdigest()

def read_range(stream,offset,length):
 stream.seek(offset)
 remaining=length
 while remaining:
  block=stream.read(min(CHUNK,remaining))
  if not block:raise ValueError('Unexpected end of input')
  yield block;remaining-=len(block)

def digest_range(stream,offset,length):
 h=hashlib.sha256()
 for block in read_range(stream,offset,length):h.update(block)
 return h.digest()

class Slice(io.RawIOBase):
 def __init__(self,path,start,length):self.file=Path(path).open('rb');self.start=start;self.length=length;self.position=0
 def readable(self):return True
 def seekable(self):return True
 def tell(self):return self.position
 def seek(self,offset,whence=0):
  position=offset if whence==0 else self.position+offset if whence==1 else self.length+offset
  if position<0:raise ValueError('Negative ZIP slice position')
  self.position=position;return position
 def read(self,size=-1):
  size=min(self.length-self.position,size if size>=0 else self.length-self.position)
  if size<=0:return b''
  self.file.seek(self.start+self.position);data=self.file.read(size);self.position+=len(data);return data
 def close(self):self.file.close();super().close()

def data_offset(stream,absolute_header_offset):
 stream.seek(absolute_header_offset);header=stream.read(30)
 if len(header)!=30 or header[:4]!=b'PK\x03\x04':raise ValueError('Invalid ZIP local header')
 name,extra=struct.unpack_from('<HH',header,26)
 return absolute_header_offset+30+name+extra

def build(base,target,patch):
 base,target,patch=map(Path,(base,target,patch))
 if patch.exists():raise ValueError('Refusing to replace an existing patch')
 segments=[]
 with base.open('rb') as old,target.open('rb') as new:
  def visit(old_start,old_size,new_start,new_size,depth=0):
   with Slice(base,old_start,old_size) as old_slice,Slice(target,new_start,new_size) as new_slice:
    with zipfile.ZipFile(old_slice) as old_zip,zipfile.ZipFile(new_slice) as new_zip:
     old_infos={entry.filename:entry for entry in old_zip.infolist()}
     for entry in new_zip.infolist():
      previous=old_infos.get(entry.filename)
      if previous is None or not entry.compress_size:continue
      old_at=data_offset(old,old_start+previous.header_offset)
      new_at=data_offset(new,new_start+entry.header_offset)
      if previous.compress_type==entry.compress_type and previous.compress_size==entry.compress_size and previous.CRC==entry.CRC and previous.file_size==entry.file_size:
       if digest_range(old,old_at,previous.compress_size)==digest_range(new,new_at,entry.compress_size):
        segments.append((new_at,old_at,entry.compress_size));continue
      if depth<2 and previous.compress_type==entry.compress_type==zipfile.ZIP_STORED and entry.filename.endswith('.zip'):
       visit(old_at,previous.compress_size,new_at,entry.compress_size,depth+1)
  visit(0,base.stat().st_size,0,target.stat().st_size)
  segments.sort()
  operations=[];cursor=0;literal_size=0;copy_size=0
  with zipfile.ZipFile(patch,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as out:
   with out.open('literal.bin','w') as literals:
    for target_at,base_at,length in segments:
     if target_at<cursor:raise ValueError('Overlapping copy segments')
     if target_at>cursor:
      length_literal=target_at-cursor;operations.append(['data',length_literal]);literal_size+=length_literal
      for block in read_range(new,cursor,length_literal):literals.write(block)
     operations.append(['copy',base_at,length]);copy_size+=length;cursor=target_at+length
    if cursor<target.stat().st_size:
     length=target.stat().st_size-cursor;operations.append(['data',length]);literal_size+=length
     for block in read_range(new,cursor,length):literals.write(block)
   manifest={'schema':SCHEMA,'baseName':base.name,'baseBytes':base.stat().st_size,'baseSha256':digest_file(base),'targetName':target.name,'targetBytes':target.stat().st_size,'targetSha256':digest_file(target),'literalBytes':literal_size,'copiedBytes':copy_size,'operations':operations}
   out.writestr('manifest.json',json.dumps(manifest,separators=(',',':'))+'\n')
  return {k:v for k,v in manifest.items() if k!='operations'}|{'operationCount':len(operations),'patchBytes':patch.stat().st_size,'patchSha256':digest_file(patch)}

def apply(base,patch,destination,expected_base,expected_target,expected_patch):
 base,patch,destination=map(Path,(base,patch,destination))
 if digest_file(patch)!=expected_patch or digest_file(base)!=expected_base:raise ValueError('Pinned input digest mismatch')
 if destination.exists():raise ValueError('Refusing to replace an existing destination')
 created=False
 try:
  with zipfile.ZipFile(patch) as source:
   infos=source.infolist()
   if sorted(x.filename for x in infos)!=['literal.bin','manifest.json']:raise ValueError('Unexpected patch entries')
   if source.getinfo('manifest.json').file_size>16*1024*1024:raise ValueError('Patch manifest too large')
   manifest=json.loads(source.read('manifest.json'))
   if manifest['schema']!=SCHEMA or manifest['baseSha256']!=expected_base or manifest['targetSha256']!=expected_target:raise ValueError('Pinned patch identity mismatch')
   if manifest['baseBytes']!=base.stat().st_size or not 0<manifest['targetBytes']<=512*1024*1024:raise ValueError('Invalid input/output sizes')
   if not 0<=manifest['literalBytes']<=manifest['targetBytes'] or source.getinfo('literal.bin').file_size!=manifest['literalBytes']:raise ValueError('Invalid literal size')
   operations=manifest['operations']
   if not isinstance(operations,list) or len(operations)>200000:raise ValueError('Too many patch operations')
   h=hashlib.sha256();written=0;literal_read=0
   with base.open('rb') as old,source.open('literal.bin') as literal,destination.open('xb') as output:
    created=True
    for operation in operations:
     if not isinstance(operation,list) or operation[0] not in ('copy','data'):raise ValueError('Invalid operation')
     if operation[0]=='copy':
      if len(operation)!=3 or any(type(x)!=int for x in operation[1:]):raise ValueError('Invalid copy operands')
      offset,length=operation[1:]
      if offset<0 or length<=0 or offset+length>manifest['baseBytes']:raise ValueError('Copy outside base file')
      blocks=read_range(old,offset,length)
     else:
      if len(operation)!=2 or type(operation[1])!=int or operation[1]<=0:raise ValueError('Invalid literal operands')
      length=operation[1];literal_read+=length
      if literal_read>manifest['literalBytes']:raise ValueError('Literal overflow')
      def literal_blocks(length):
       while length:
        block=literal.read(min(CHUNK,length))
        if not block:raise ValueError('Unexpected literal EOF')
        yield block;length-=len(block)
      blocks=literal_blocks(length)
     written+=length
     if written>manifest['targetBytes']:raise ValueError('Output overflow')
     for block in blocks:output.write(block);h.update(block)
    if written!=manifest['targetBytes'] or literal_read!=manifest['literalBytes'] or literal.read(1):raise ValueError('Incomplete reconstruction')
    if h.hexdigest()!=expected_target:raise ValueError('Reconstructed target digest mismatch')
   return {'targetSha256':h.hexdigest(),'targetBytes':written,'byteExact':True}
 except Exception:
  if created:destination.unlink(missing_ok=True)
  raise

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
 b=sub.add_parser('build');b.add_argument('base');b.add_argument('target');b.add_argument('patch')
 a=sub.add_parser('apply');a.add_argument('base');a.add_argument('patch');a.add_argument('destination');a.add_argument('--base-sha',required=True);a.add_argument('--target-sha',required=True);a.add_argument('--patch-sha',required=True)
 args=parser.parse_args()
 result=build(args.base,args.target,args.patch) if args.command=='build' else apply(args.base,args.patch,args.destination,args.base_sha,args.target_sha,args.patch_sha)
 print(json.dumps(result,indent=2))
