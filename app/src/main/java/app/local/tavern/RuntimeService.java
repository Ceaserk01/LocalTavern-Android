package app.local.tavern;

import android.app.*;
import android.content.Intent;
import android.os.*;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public final class RuntimeService extends Service {
    private static final String CHANNEL = "local-tavern-runtime";
    private boolean running;
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "本地酒馆运行状态", NotificationManager.IMPORTANCE_LOW));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && RuntimeContract.ACTION_STOP.equals(intent.getAction())) {
            status("stopping", "正在保存数据并停止本地服务…");
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                stopForeground(STOP_FOREGROUND_REMOVE);
                android.os.Process.killProcess(android.os.Process.myPid());
            }, 5000);
            // SillyTavern's SIGTERM handler saves stats and runs plugin cleanup before exiting.
            android.os.Process.sendSignal(android.os.Process.myPid(), 15);
            return START_NOT_STICKY;
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, RuntimeService.class).setAction(RuntimeContract.ACTION_STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("本地酒馆正在运行").setContentText("聊天数据保存在手机中 · 点击返回酒馆")
            .setContentIntent(content).setOngoing(true).addAction(new Notification.Action.Builder(null, "停止服务", stop).build()).build();
        startForeground(1001, notification);
        if (!running) {
            running = true;
            new Thread(() -> {
                try {
                    status("installing", "正在校验并准备完整酒馆，首次启动需要一些时间…");
                    File root = BundleInstaller.install(this);
                    status("starting", "正在启动手机本地服务…");
                    int result = NodeBridge.start(root.getAbsolutePath(), RuntimeContract.data(this).getAbsolutePath(), getCacheDir().getAbsolutePath(), RuntimeContract.log(this).getAbsolutePath(), RuntimeContract.PORT);
                    status("failed", "本地运行时已退出，退出码 " + result + "。请查看日志或重启。");
                } catch (Throwable error) {
                    status("failed", error.getClass().getSimpleName() + ": " + error.getMessage());
                }
                stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
            }, "SillyTavern-Node").start();
        }
        return START_NOT_STICKY;
    }
    private void status(String state, String message) {
        try {
            JSONObject json = new JSONObject().put("state", state).put("message", message).put("pid", android.os.Process.myPid()).put("time", System.currentTimeMillis());
            File staging = new File(getFilesDir(), "runtime-status.tmp");
            Files.write(staging.toPath(), json.toString().getBytes(StandardCharsets.UTF_8));
            Files.move(staging.toPath(), RuntimeContract.status(this).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception ignored) {}
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        super.onDestroy();
        if (running) android.os.Process.killProcess(android.os.Process.myPid());
    }
}
