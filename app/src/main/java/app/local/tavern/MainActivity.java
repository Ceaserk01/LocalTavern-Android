package app.local.tavern;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.webkit.CookieManager;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final int UPLOAD = 10, EXTENSION = 11, SERVER_PLUGIN = 12, BACKUP = 13, RESTORE = 14, DOWNLOAD = 15, MIC = 20;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private WebView web;
    private NativeTtsController nativeTts;
    private NativeClipboardController nativeClipboard;
    private LinearLayout boot;
    private TextView status;
    private ProgressBar progress;
    private ValueCallback<Uri[]> upload;
    private PermissionRequest microphone;
    private boolean ready, closing, busy, runtimeStarting, runtimeChecking, resumed;
    private int runtimeGeneration;
    private final Runnable resumeRuntimeCheck = this::checkRuntimeOnResume;
    private String downloadUrl, downloadAgent, blobKey;
    private OutputStream downloadStream;
    private long blobOffset;
    private volatile int downloadGeneration;
    private long requestedStartMillis;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(21,25,34));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(this); toolbar.setGravity(Gravity.CENTER_VERTICAL); toolbar.setPadding(dp(12),0,dp(4),0);
        TextView title = text("本地酒馆", 16); toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(44),1)); title.setGravity(Gravity.CENTER_VERTICAL);
        Button menu = button("☰", v -> showMenu()); menu.setContentDescription("本地酒馆管理：扩展、备份和运行状态"); toolbar.addView(menu,new LinearLayout.LayoutParams(dp(52),dp(44))); root.addView(toolbar);
        progress = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setIndeterminate(true); root.addView(progress,new LinearLayout.LayoutParams(-1,dp(2)));
        FrameLayout content = new FrameLayout(this); root.addView(content,new LinearLayout.LayoutParams(-1,0,1));
        web = new WebView(this); nativeTts = new NativeTtsController(this); nativeClipboard = new NativeClipboardController(this); content.addView(web,new FrameLayout.LayoutParams(-1,-1)); configureWebView(); web.setVisibility(View.GONE);
        boot = new LinearLayout(this); boot.setOrientation(LinearLayout.VERTICAL); boot.setGravity(Gravity.CENTER); boot.setPadding(dp(28),dp(24),dp(28),dp(24));
        boot.addView(text("你的酒馆，在手机里",24));
        TextView hint = text("安装后直接运行 · 角色与聊天留在本机",14); hint.setPadding(0,dp(12),0,dp(24)); boot.addView(hint);
        status = text("正在准备运行环境…",15); status.setGravity(Gravity.CENTER); boot.addView(status);
        boot.addView(button("重试启动",v -> restartRuntime())); boot.addView(button("查看日志",v -> showLog()));
        content.addView(boot,new FrameLayout.LayoutParams(-1,-1)); setContentView(root);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},21);
        startRuntime();
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(true); s.setSupportMultipleWindows(true);
        s.setBuiltInZoomControls(false); s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setBackgroundColor(Color.rgb(21,25,34));
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                if (isLocal(uri)) return false;
                if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()) || "mailto".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (ActivityNotFoundException e) { error("没有可打开此链接的应用"); }
                }
                return true;
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon) {
                nativeTts.detach();
                nativeClipboard.detach();
                if (blobKey!=null && !url.startsWith("blob:")) clearDownload();
                progress.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view,String url) {
                progress.setVisibility(View.GONE); CookieManager.getInstance().flush();
                if (!closing && isLocal(Uri.parse(url)) && url.equals(view.getUrl())) {
                    nativeTts.attach(view); nativeClipboard.attach(view);
                }
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError e) {
                if (request.isForMainFrame()) { nativeClipboard.detach(); ready=false; web.setVisibility(View.GONE); boot.setVisibility(View.VISIBLE); status.setText("本地页面暂时不可用。请查看日志或重启服务。"); progress.setVisibility(View.GONE); }
            }
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error) { handler.cancel(); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view,boolean dialog,boolean gesture,Message result) {
                if(!gesture) return false;
                WebView popup=new WebView(MainActivity.this);
                popup.setDownloadListener((url,agent,disposition,mime,length)->{
                    handleDownload(url,agent,disposition,mime);popup.stopLoading();popup.destroy();
                });
                popup.setWebViewClient(new WebViewClient() {
                    @Override public void onPageStarted(WebView child,String url,android.graphics.Bitmap icon) {
                        if(url==null || url.equals("about:blank")) return;
                        Uri uri=Uri.parse(url);
                        if(url.startsWith("blob:")) handleDownload(url,null,null,null);
                        else if(isLocal(uri)) web.loadUrl(url);
                        else if("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()) || "mailto".equals(uri.getScheme())) {
                            try { startActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
                            catch(ActivityNotFoundException e) { error("没有可打开此链接的应用"); }
                        }
                        child.stopLoading(); child.destroy();
                    }
                });
                ((WebView.WebViewTransport)result.obj).setWebView(popup);result.sendToTarget();return true;
            }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null); upload=callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = Arrays.stream(params.getAcceptTypes()).filter(t -> t != null && t.contains("/")).toArray(String[]::new);
                if (types.length == 1) intent.setType(types[0]); else if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES,types);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent,UPLOAD); } catch (Exception e) { upload.onReceiveValue(null); upload=null; error("无法打开文件选择器"); }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!isLocal(request.getOrigin()) || !Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    else { if (microphone != null) microphone.deny(); microphone=request; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},MIC); }
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (microphone==request) microphone=null; }
            @Override public boolean onJsAlert(WebView view,String url,String message,JsResult result) { new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show(); return true; }
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result) { new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show(); return true; }
        });
        web.setDownloadListener((url,agent,disposition,mime,length) -> handleDownload(url,agent,disposition,mime));
    }
    private void handleDownload(String url,String agent,String disposition,String mime) {
        if (busy || downloadUrl!=null) {
            if(url.startsWith("blob:")) web.evaluateJavascript("window.__LOCAL_TAVERN_DOWNLOADS__?.discard("+JSONObject.quote(url)+")",null);
            error("请等待当前文件操作完成"); return;
        }
        if (!url.startsWith("blob:") && !isLocal(Uri.parse(url)) && !url.startsWith("https://")) { error("不支持这个下载地址"); return; }
        downloadUrl=url; downloadAgent=agent; busy=true;
        String guessed=URLUtil.guessFileName(url,disposition,mime);
        final String fallback=(guessed==null || guessed.isEmpty() || guessed.equals("downloadfile.bin")) ? "SillyTavern-export" : guessed;
        final String fallbackMime=mime==null ? "application/octet-stream" : mime;
        if(!url.startsWith("blob:")) { createDocument(DOWNLOAD,fallback,fallbackMime); return; }
        final int generation=++downloadGeneration;
        blobKey="__tavern_export_"+UUID.randomUUID().toString().replace("-","");
        String key=JSONObject.quote(blobKey);
        // Claim before showing SAF: upstream revokes the original URL in the click's stack.
        web.evaluateJavascript("(()=>{const r=window.__LOCAL_TAVERN_DOWNLOADS__,d=r?.claim("+JSONObject.quote(url)+");if(!d)return null;window["+key+"]={state:'ready',blob:d.blob,size:d.blob.size,ticket:d.id};return JSON.stringify({name:d.name,mime:d.blob.type,size:d.blob.size})})()",raw->{
            if(generation!=downloadGeneration || closing) return;
            try {
                if(raw==null || raw.equals("null")) throw new IOException("未能保留导出文件，请重新导出");
                JSONObject metadata=new JSONObject(new JSONArray("["+raw+"]").getString(0));
                if(metadata.getLong("size")>2L*1024*1024*1024) throw new IOException("导出文件超过 2 GB");
                String name=metadata.optString("name").replaceAll("[\\\\/\\p{Cntrl}]","_");
                String type=metadata.optString("mime");
                createDocument(DOWNLOAD,name.isEmpty()?fallback:name,type.isEmpty()?fallbackMime:type);
            } catch(Exception e) { clearDownload(); error("导出失败："+e.getMessage()); }
        });
    }
    private boolean isLocal(Uri uri) { return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort()==RuntimeContract.PORT; }

    private boolean isRuntimeReady() {
        HttpURLConnection connection=null;
        try {
            connection=(HttpURLConnection)new URL(RuntimeContract.ORIGIN+"/csrf-token").openConnection();
            connection.setConnectTimeout(700); connection.setReadTimeout(700);
            return connection.getResponseCode()==200;
        } catch (Exception ignored) { return false; }
        finally { if(connection!=null) connection.disconnect(); }
    }
    private void checkRuntimeOnResume() {
        if (closing || !resumed) return;
        if (busy || upload!=null || downloadUrl!=null) { ui.postDelayed(resumeRuntimeCheck,1000); return; }
        if (runtimeStarting || runtimeChecking) return;
        if (!ready) { startRuntime(); return; }
        runtimeChecking=true;
        final int generation=runtimeGeneration;
        io.execute(()->{
            boolean available=isRuntimeReady();
            ui.post(()->{
                if (generation!=runtimeGeneration) return;
                runtimeChecking=false;
                if (closing || !resumed) return;
                if (busy || upload!=null || downloadUrl!=null) { ui.postDelayed(resumeRuntimeCheck,1000); return; }
                if (!available) startRuntime(true);
            });
        });
    }
    private void startRuntime() { startRuntime(false); }
    private void startRuntime(boolean preservePage) {
        if (closing || busy || runtimeStarting) return;
        ready=false; runtimeStarting=true; runtimeChecking=false;
        final int generation=++runtimeGeneration;
        requestedStartMillis=System.currentTimeMillis();
        if(preservePage) { web.setVisibility(View.GONE); boot.setVisibility(View.VISIBLE); status.setText("正在恢复本地服务…"); progress.setVisibility(View.VISIBLE); }
        try { startForegroundService(new Intent(this,RuntimeService.class)); pollReady(0,generation,preservePage); }
        catch (Exception e) { runtimeStarting=false; status.setText("服务无法启动："+e.getMessage()); progress.setVisibility(View.GONE); }
    }
    private void pollReady(int attempt,int generation,boolean preservePage) {
        if (closing || generation!=runtimeGeneration) return;
        if (busy) { ui.postDelayed(()->pollReady(attempt,generation,preservePage),1000); return; }
        io.execute(() -> {
            boolean ok=isRuntimeReady(); String message="正在启动本地服务…", state="starting";
            if (!ok) try {
                JSONObject json=new JSONObject(new String(BundleInstaller.readAll(new FileInputStream(RuntimeContract.status(this))),StandardCharsets.UTF_8));
                if(json.optLong("time",0)>=requestedStartMillis) {message=json.optString("message",message);state=json.optString("state",state);}
            } catch (Exception ignored) {}
            boolean available=ok; String finalMessage=message, finalState=state;
            ui.post(() -> {
                if (closing || generation!=runtimeGeneration) return;
                if (busy) { ui.postDelayed(()->pollReady(attempt,generation,preservePage),1000); return; }
                if (available) {
                    runtimeStarting=false; ready=true; boot.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); progress.setVisibility(View.GONE);
                    // A service restart does not require a navigation: keep the live chat and unsent draft.
                    if(!preservePage) web.loadUrl(RuntimeContract.ORIGIN+"/");
                } else {
                    status.setText(finalMessage);
                    if (attempt<240 && !finalState.equals("failed") && !finalState.equals("stopped")) ui.postDelayed(()->pollReady(attempt+1,generation,preservePage),1000);
                    else { runtimeStarting=false; progress.setVisibility(View.GONE); }
                }
            });
        });
    }
    private void stopRuntime() {
        runtimeGeneration++; runtimeStarting=false; runtimeChecking=false;
        startService(new Intent(this,RuntimeService.class).setAction(RuntimeContract.ACTION_STOP));
    }
    private void restartRuntime() {
        if (busy) return;
        busy=true;
        ready=false; web.stopLoading(); web.setVisibility(View.GONE); boot.setVisibility(View.VISIBLE); progress.setVisibility(View.VISIBLE); status.setText("正在重启本地服务…");
        stopRuntime();
        io.execute(()->{
            try {awaitRuntimeStopped();ui.post(()->{busy=false;startRuntime();});}
            catch(Exception e) {ui.post(()->{busy=false;progress.setVisibility(View.GONE);error("重启失败："+e.getMessage());});}
        });
    }
    private void showMenu() {
        String[] labels={"导入前端扩展 ZIP","导入服务端插件 ZIP","备份全部数据","恢复本地酒馆备份","重新加载界面","重启本地服务","查看启动日志","使用说明与兼容范围","开源许可","停止服务并退出"};
        new AlertDialog.Builder(this).setTitle("本地酒馆管理").setItems(labels,(dialog,which)->{
            if (busy) { error("请等待当前文件操作完成"); return; }
            switch(which) {
                case 0: pickZip(EXTENSION); break;
                case 1: new AlertDialog.Builder(this).setTitle("导入服务端插件").setMessage("插件会在本机 Node.js 中执行代码，并能访问酒馆数据和网络。请仅导入你信任的插件。需要额外 npm 依赖的插件，请将依赖一起放入 ZIP 的 node_modules。导入后需重启服务。").setPositiveButton("选择 ZIP",(d,w)->pickZip(SERVER_PLUGIN)).setNegativeButton("取消",null).show(); break;
                case 2: createDocument(BACKUP,"local-tavern-"+new java.text.SimpleDateFormat("yyyyMMdd-HHmm",Locale.ROOT).format(new Date())+".zip","application/zip"); break;
                case 3: new AlertDialog.Builder(this).setTitle("恢复备份").setMessage("恢复会替换本机角色、聊天、API 密钥和扩展。请先导出当前备份。恢复期间服务会停止。").setPositiveButton("选择备份",(d,w)->pickZip(RESTORE)).setNegativeButton("取消",null).show(); break;
                case 4: if (ready) web.reload(); else startRuntime(); break;
                case 5: restartRuntime(); break;
                case 6: showLog(); break;
                case 7: new AlertDialog.Builder(this).setTitle("安装即用的本地酒馆").setMessage("打开酒馆的 API 连接面板，填写模型服务地址和 API Key 后即可聊天。角色卡、世界书、预设及扩展均使用上游 SillyTavern 界面管理。\n\n前端扩展可从酒馆中的 Git 仓库地址安装，也可用此菜单导入 ZIP。服务端插件支持纯 JavaScript 和随包提供的依赖；依赖桌面原生二进制或外部服务的插件需要对应的安卓支持或服务。\n\n文件导入使用系统文件选择器；下载会让你选择保存位置。备份中包含 API 密钥，请妥善保存。\n\n应用后台通过常驻通知保持本地服务；系统省电策略仍可能终止服务。返回应用可重试启动。\n\n酒馆在手机本地运行，模型推理通过你配置的 API 完成。项目与 SillyTavern 源码按 AGPL-3.0 提供。").setPositiveButton("知道了",null).show(); break;
                case 8: showLicenses(); break;
                case 9: closing=true; stopRuntime(); finishAndRemoveTask(); break;
            }
        }).show();
    }
    private void pickZip(int request) {
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/zip","application/x-zip-compressed","application/octet-stream"});
        startActivityForResult(intent,request);
    }
    private void createDocument(int request,String name,String mime) {
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE,name),request); }
        catch (Exception e) { if(request==DOWNLOAD) clearDownload(); error("无法打开保存位置选择器"); }
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if (request==UPLOAD) {
            if (upload!=null) {
                Uri[] values=null;
                if (result==RESULT_OK && data!=null) {
                    if (data.getClipData()!=null) { ClipData clip=data.getClipData(); values=new Uri[clip.getItemCount()]; for(int i=0;i<values.length;i++) values[i]=clip.getItemAt(i).getUri(); }
                    else if (data.getData()!=null) values=new Uri[]{data.getData()};
                }
                upload.onReceiveValue(values); upload=null;
            } return;
        }
        if (result!=RESULT_OK || data==null || data.getData()==null) { if(request==DOWNLOAD) clearDownload(); return; }
        Uri uri=data.getData();
        if (request==DOWNLOAD) { saveDownload(uri); return; }
        if (request==EXTENSION || request==SERVER_PLUGIN) {
            busy=true; toast("正在校验并导入扩展…");
            io.execute(()->{
                try { String name=BundleInstaller.importPlugin(this,uri,request==SERVER_PLUGIN); ui.post(()->new AlertDialog.Builder(this).setTitle("导入成功").setMessage(name+(request==SERVER_PLUGIN ? "\n重启服务后插件生效。" : "\n重新加载酒馆界面后可在扩展面板启用。")).setPositiveButton(request==SERVER_PLUGIN ? "重启服务" : "重新加载",(d,w)->{ if(request==SERVER_PLUGIN) restartRuntime(); else web.reload(); }).setNegativeButton("稍后",null).show()); }
                catch(Exception e) { ui.post(()->error("导入失败："+e.getMessage())); }
                finally { ui.post(()->busy=false); }
            });
        } else if (request==BACKUP || request==RESTORE) {
            busy=true; ready=false; web.setVisibility(View.GONE); boot.setVisibility(View.VISIBLE); status.setText(request==BACKUP ? "正在导出备份，请保持应用打开…" : "正在恢复数据，请保持应用打开…"); progress.setVisibility(View.VISIBLE); stopRuntime();
            ui.postDelayed(()->io.execute(()->{
                try { awaitRuntimeStopped(); if(request==BACKUP) BundleInstaller.backup(this,uri); else BundleInstaller.restore(this,uri); ui.post(()->toast(request==BACKUP ? "备份已保存" : "数据已恢复")); }
                catch(Exception e) { ui.post(()->error("文件操作失败："+e.getMessage())); }
                finally { ui.post(()->{busy=false; startRuntime();}); }
            }),900);
        }
    }
    private void saveDownload(Uri destination) {
        if(downloadUrl==null) return;
        if(downloadUrl.startsWith("blob:")) { startBlobDownload(destination); return; }
        String url=downloadUrl, agent=downloadAgent; busy=true;
        io.execute(()->{
            HttpURLConnection connection=null;
            try {
                connection=(HttpURLConnection)new URL(url).openConnection(); connection.setConnectTimeout(20000); connection.setReadTimeout(60000); connection.setInstanceFollowRedirects(false);
                if(agent!=null) connection.setRequestProperty("User-Agent",agent);
                String cookie=CookieManager.getInstance().getCookie(url); if(cookie!=null) connection.setRequestProperty("Cookie",cookie);
                if(connection.getResponseCode()!=200) throw new IOException("下载返回 HTTP "+connection.getResponseCode());
                try(InputStream in=connection.getInputStream();OutputStream out=getContentResolver().openOutputStream(destination)) { BundleInstaller.copy(in,out); }
                ui.post(()->toast("文件已保存"));
            } catch(Exception e) { ui.post(()->error("下载失败："+e.getMessage())); }
            finally { if(connection!=null) connection.disconnect(); ui.post(()->{busy=false;downloadUrl=null;}); }
        });
    }
    private void awaitRuntimeStopped() throws Exception {
        ActivityManager manager=getSystemService(ActivityManager.class);
        for(int attempt=0;attempt<100;attempt++) {
            boolean runtimeAlive=false;
            List<ActivityManager.RunningAppProcessInfo> processes=manager.getRunningAppProcesses();
            if(processes==null) throw new IOException("无法确认本地服务是否已停止，请稍后重试");
            for(ActivityManager.RunningAppProcessInfo process:processes)
                if(process.processName.equals(getPackageName()+":runtime")) runtimeAlive=true;
            if(!runtimeAlive) return;
            Thread.sleep(100);
        }
        throw new IOException("本地服务尚未停止，数据未修改。请稍后重试。");
    }
    // Chunked blob export uses evaluation callbacks, without exposing a JavaScript-to-Java bridge.
    private void startBlobDownload(Uri destination) {
        if(blobKey==null) { clearDownload(); error("导出文件已释放，请重新导出"); return; }
        busy=true; blobOffset=0;
        try { downloadStream=getContentResolver().openOutputStream(destination); if(downloadStream==null) throw new IOException("无法创建文件"); }
        catch(Exception e) { finishBlob("无法打开保存文件："+e.getMessage()); return; }
        pollBlob(downloadGeneration,0);
    }
    private void pollBlob(int generation,int attempt) {
        if(blobKey==null || generation!=downloadGeneration || closing) return;
        String key=JSONObject.quote(blobKey);
        web.evaluateJavascript("(()=>{let s=window["+key+"];return s?JSON.stringify({state:s.state,size:s.size,error:s.error,chunk:s.chunk}):null})()",raw->{
            if(generation!=downloadGeneration || closing) return;
            try {
                if(raw==null || raw.equals("null")) throw new IOException("导出页面已关闭");
                JSONObject state=new JSONObject(new JSONArray("["+raw+"]").getString(0));
                String current=state.optString("state");
                if(current.equals("error")) throw new IOException(state.optString("error"));
                if(current.equals("loading")) { if(attempt>1200) throw new IOException("读取导出文件超时"); ui.postDelayed(()->pollBlob(generation,attempt+1),50); return; }
                long size=state.getLong("size"); if(size>2L*1024*1024*1024) throw new IOException("导出文件超过 2 GB");
                if(current.equals("chunk")) {
                    byte[] chunk=android.util.Base64.decode(state.getString("chunk"),android.util.Base64.DEFAULT);
                    final OutputStream target=downloadStream;
                    final long nextOffset=blobOffset+chunk.length;
                    io.execute(()->{
                        if(generation!=downloadGeneration) return;
                        try { target.write(chunk); ui.post(()->{ if(generation==downloadGeneration && !closing) {blobOffset=nextOffset;nextBlobChunk(generation,size);} }); }
                        catch(Exception e) { ui.post(()->{ if(generation==downloadGeneration && !closing) finishBlob("保存失败："+e.getMessage()); }); }
                    });
                } else nextBlobChunk(generation,size);
            } catch(Exception e) { finishBlob("导出失败："+e.getMessage()); }
        });
    }
    private void nextBlobChunk(int generation,long size) {
        if(generation!=downloadGeneration || blobKey==null || closing) return;
        if(blobOffset>=size) { finishBlob(null); return; }
        String key=JSONObject.quote(blobKey);
        web.evaluateJavascript("(()=>{let s=window["+key+"];if(!s)return false;s.state='loading';s.chunk=null;s.blob.slice("+blobOffset+","+(blobOffset+128*1024)+").arrayBuffer().then(b=>{let u=new Uint8Array(b),t='';for(let i=0;i<u.length;i+=8192)t+=String.fromCharCode(...u.subarray(i,i+8192));s.chunk=btoa(t);s.state='chunk'}).catch(e=>{s.error=String(e);s.state='error'});return true})()",v->ui.postDelayed(()->pollBlob(generation,0),10));
    }
    private void finishBlob(String failure) {
        try { if(downloadStream!=null) downloadStream.close(); }
        catch(IOException e) { if(failure==null) failure="保存失败："+e.getMessage(); }
        downloadStream=null; clearDownload();
        if(failure==null) toast("文件已保存"); else error(failure);
    }
    private void clearDownload() {
        downloadGeneration++;
        if(blobKey!=null && web!=null) {
            String key=JSONObject.quote(blobKey);
            web.evaluateJavascript("(()=>{const s=window["+key+"];if(s)window.__LOCAL_TAVERN_DOWNLOADS__?.release(s.ticket);delete window["+key+"]})()",null);
        }
        final OutputStream old=downloadStream;
        if(old!=null) io.execute(()->{try {old.close();}catch(IOException ignored){}});
        if(downloadUrl!=null) busy=false;
        downloadStream=null;blobKey=null;downloadUrl=null;downloadAgent=null;blobOffset=0;
    }
    private void showLog() {
        io.execute(()->{
            String value;
            try(RandomAccessFile file=new RandomAccessFile(RuntimeContract.log(this),"r")) {
                long start=Math.max(0,file.length()-64*1024); file.seek(start); byte[] bytes=new byte[(int)(file.length()-start)];file.readFully(bytes);value=new String(bytes,StandardCharsets.UTF_8);
            } catch(Exception e) { value="暂无运行日志。\n"+e.getMessage(); }
            String log=value;
            ui.post(()->{ TextView text=text(log,12);text.setTextIsSelectable(true);text.setTypeface(android.graphics.Typeface.MONOSPACE);text.setPadding(dp(16),dp(12),dp(16),dp(12)); ScrollView scroll=new ScrollView(this);scroll.addView(text);new AlertDialog.Builder(this).setTitle("本地运行日志（最近 64 KB）").setView(scroll).setPositiveButton("关闭",null).show(); });
        });
    }
    private void showLicenses() {
        String[] names={"开源组件说明","SillyTavern · AGPL-3.0","Node.js 运行时许可","Zstandard · BSD-3-Clause"};
        String[] assets={"NOTICE.txt","SillyTavern-LICENSE.txt","Node-LICENSE.txt","Zstd-LICENSE.txt"};
        new AlertDialog.Builder(this).setTitle("开源许可").setItems(names,(d,which)->io.execute(()->{
            String value;
            try {value=new String(BundleInstaller.readAll(getAssets().open(assets[which])),StandardCharsets.UTF_8);}
            catch(Exception e) {value="无法读取许可文件："+e.getMessage();}
            String content=value;
            ui.post(()->{TextView body=text(content,12);body.setTextIsSelectable(true);body.setPadding(dp(16),dp(12),dp(16),dp(12));ScrollView scroll=new ScrollView(this);scroll.addView(body);new AlertDialog.Builder(this).setTitle(names[which]).setView(scroll).setPositiveButton("关闭",null).show();});
        })).show();
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] result) {
        super.onRequestPermissionsResult(request,permissions,result);
        if(request==MIC && microphone!=null) { if(result.length>0 && result[0]==PackageManager.PERMISSION_GRANTED) microphone.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else microphone.deny(); microphone=null; }
    }
    @Override public void onBackPressed() { if(busy) { toast("正在处理文件，请稍候"); return; } if(web.canGoBack()) web.goBack(); else moveTaskToBack(true); }
    @Override protected void onResume() { super.onResume(); resumed=true; if(nativeClipboard!=null) nativeClipboard.setForeground(true); if(web!=null) web.onResume(); ui.removeCallbacks(resumeRuntimeCheck); ui.post(resumeRuntimeCheck); }
    @Override protected void onPause() { resumed=false; if(nativeClipboard!=null) nativeClipboard.setForeground(false); ui.removeCallbacks(resumeRuntimeCheck); if(web!=null) {web.onPause();CookieManager.getInstance().flush();} super.onPause(); }
    @Override protected void onDestroy() {
        closing=true;ui.removeCallbacksAndMessages(null);
        if(upload!=null) upload.onReceiveValue(null);if(microphone!=null) microphone.deny();
        clearDownload();
        if(nativeTts!=null) nativeTts.destroy();
        if(nativeClipboard!=null) nativeClipboard.destroy();
        if(web!=null) {web.stopLoading();web.destroy();} io.shutdown();super.onDestroy();
    }
    private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
    private TextView text(String value,int size) { TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(Color.rgb(225,228,235));return v; }
    private Button button(String label,View.OnClickListener action) { Button b=new Button(this);b.setText(label);b.setTextColor(Color.rgb(218,185,130));b.setOnClickListener(action);return b; }
    private void toast(String message) { Toast.makeText(this,message,Toast.LENGTH_LONG).show(); }
    private void error(String message) { if(!isFinishing() && !closing) new AlertDialog.Builder(this).setTitle("本地酒馆").setMessage(message).setPositiveButton("确定",null).show(); }
}
