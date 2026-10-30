#!/usr/bin/env python3
"""Build/run a disposable-emulator-only native interaction instrumentation APK.

The default --build-only mode never talks to ADB or reads signing variables.
--run intentionally restarts the target through Android instrumentation. It uses
only supplied signing environment variables, and never prints raw instrument
output (which must not become a route for clipboard/draft disclosure).
TAVERN_INTERACTION_ONBOARDING=1 explicitly permits the test's exact first-run
onboarding OK action. It may persist onboarding completion in disposable QA data;
the runner does not claim global settings remain unchanged with that opt-in.
TAVERN_INTERACTION_CLIPBOARD_CONSENT=1 permits only the test's explicit native
clipboard consent checks; without it, direct clipboard behavior is tested.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
TARGET_PACKAGE = 'app.local.tavern'
TEST_PACKAGE = 'app.local.tavern.interactiontest'
COMPONENT = TEST_PACKAGE + '/.InteractionInstrumentation'
SIGNING_NAMES = ('TAVERN_KEYSTORE_FILE', 'TAVERN_KEYSTORE_PASSWORD',
                 'TAVERN_KEY_ALIAS', 'TAVERN_KEY_PASSWORD')


class Failure(Exception):
    """A deliberately bounded diagnostic containing no command output."""


def command(argv, label, env, timeout=60, allow_failure=False):
    try:
        result = subprocess.run([str(value) for value in argv], cwd=ROOT, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failure(label + ' timed out') from None
    except OSError:
        raise Failure(label + ' could not start') from None
    if result.returncode and not allow_failure:
        raise Failure(label + ' failed (exit ' + str(result.returncode) + ')')
    return result


def tool_file(path, label):
    if not path.is_file():
        raise Failure(label + ' is missing; install the pinned local Android/JDK tools')
    return path


def safe_report(value):
    # The Java runner owns this schema; forbid arbitrary strings even if a test
    # exception unexpectedly includes the contents it was checking.
    if not isinstance(value, dict) or not isinstance(value.get('passed'), bool):
        raise Failure('Instrumentation did not return a valid bounded report')
    output = {}
    for key, item in value.items():
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', key):
            raise Failure('Instrumentation report has an invalid field name')
        if isinstance(item, (bool, int, float)) or item is None:
            output[key] = item
        elif key == 'errorCode' and isinstance(item, str) and re.fullmatch(r'[A-Z0-9_]{0,96}', item):
            output[key] = item
        elif key == 'phase' and isinstance(item, str) and item in {'guard', 'launch', 'ready', 'capture', 'nativeFocus', 'nativeTyping', 'guestClipboard'}:
            output[key] = item
        elif key in {'clipboardErrorName', 'clipboardWriteErrorName', 'clipboardDenyErrorName'} and isinstance(item, str) and item in {'', 'unsupported', 'timeout', 'NotAllowedError', 'SecurityError', 'NotFoundError', 'UnknownError'}:
            output[key] = item
        else:
            raise Failure('Instrumentation report contains a non-permitted value')
    return output


def parse_instrumentation(text):
    reports = re.findall(r'^INSTRUMENTATION_RESULT: report_json=(.+)$', text, re.MULTILINE)
    codes = re.findall(r'^INSTRUMENTATION_CODE:\s*(-?\d+)\s*$', text, re.MULTILINE)
    if len(reports) != 1 or not codes:
        raise Failure('Android instrumentation did not return its expected report')
    try:
        report = safe_report(json.loads(reports[0]))
    except (ValueError, TypeError):
        raise Failure('Android instrumentation returned an unreadable report') from None
    report['instrumentationFinishedSuccessfully'] = codes[-1] == '-1'
    report['passed'] = report['passed'] and report['instrumentationFinishedSuccessfully']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--build-only', action='store_true', help='build an unsigned test APK without ADB/signing (default)')
    mode.add_argument('--run', action='store_true', help='sign, install and run only on the explicitly chosen disposable emulator')
    args = parser.parse_args()
    sdk = Path(os.environ.get('ANDROID_HOME', ROOT / '.tooling/android')).resolve()
    jdk = Path(os.environ.get('JAVA_HOME', ROOT / '.tooling/jdk/Contents/Home')).resolve()
    env = os.environ.copy()
    env['JAVA_HOME'] = str(jdk)
    android_jar = tool_file(sdk / 'platforms/android-35/android.jar', 'Android 35 android.jar')
    build_tools = sdk / 'build-tools/35.0.0'
    javac = tool_file(jdk / 'bin/javac', 'JDK javac')
    aapt = tool_file(build_tools / 'aapt2', 'aapt2')
    dexer = tool_file(build_tools / 'd8', 'D8')
    zipalign = tool_file(build_tools / 'zipalign', 'zipalign')
    serial, adb = None, None
    if args.run:
        if os.environ.get('TAVERN_UI_TEST_DISPOSABLE') != '1':
            raise Failure('Set TAVERN_UI_TEST_DISPOSABLE=1 only for a disposable test emulator')
        serial = os.environ.get('TAVERN_BENCH_ADB_SERIAL', '')
        if not re.fullmatch(r'emulator-[0-9]+', serial):
            raise Failure('Set an explicit emulator-N TAVERN_BENCH_ADB_SERIAL')
        if any(not os.environ.get(name) for name in SIGNING_NAMES):
            raise Failure('Provide all four TAVERN_* signing variables for the target APK certificate')
        if not Path(os.environ['TAVERN_KEYSTORE_FILE']).is_file():
            raise Failure('The provided signing keystore does not exist')
        adb = tool_file(Path(os.environ.get('TAVERN_BENCH_ADB_PATH', sdk / 'platform-tools/adb')), 'ADB')
        qemu = command([adb, '-s', serial, 'shell', 'getprop', 'ro.kernel.qemu'], 'Emulator guard', env).stdout.strip()
        if qemu != '1':
            raise Failure('Refusing to operate on a physical Android device')
        api = command([adb, '-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], 'API guard', env).stdout.strip()
        if not api.isdigit() or int(api) < 30:
            raise Failure('This native test harness requires an API 30+ emulator')
        pid = command([adb, '-s', serial, 'shell', 'pidof', TARGET_PACKAGE], 'Target process guard', env).stdout.strip()
        if not re.fullmatch(r'[0-9]+', pid):
            raise Failure('Open the target app first; exactly one main process is required')
        existing = command([adb, '-s', serial, 'shell', 'pm', 'path', TEST_PACKAGE],
                           'Existing test package guard', env, allow_failure=True)
        if existing.returncode == 0 and existing.stdout.strip().startswith('package:'):
            raise Failure('A test package is already installed; refusing to replace or delete it')

    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='android-interaction-', dir=cache))
    classes = work / 'classes'
    dex = work / 'dex'
    classes.mkdir(); dex.mkdir()
    sources = sorted((SOURCE / 'src').rglob('*.java'))
    if not sources:
        raise Failure('Native interaction test source is missing')
    command([javac, '--release', '17', '-encoding', 'UTF-8', '-cp', android_jar,
             '-d', classes] + sources, 'Java compilation', env)
    class_files = sorted(classes.rglob('*.class'))
    if not class_files:
        raise Failure('Java compilation did not produce test classes')
    command([dexer, '--lib', android_jar, '--min-api', '30', '--output', dex] + class_files,
            'Test DEX generation', env)
    if not (dex / 'classes.dex').is_file():
        raise Failure('DEX generation did not produce executable test code')
    resources = work / 'resources.apk'
    command([aapt, 'link', '-I', android_jar, '--manifest', SOURCE / 'AndroidManifest.xml',
             '--min-sdk-version', '30', '--target-sdk-version', '35', '-o', resources],
            'Test APK manifest packaging', env)
    unsigned = work / 'test-unsigned.apk'
    shutil.copyfile(resources, unsigned)
    with zipfile.ZipFile(unsigned, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(dex.glob('classes*.dex')):
            archive.write(file, file.name)
    aligned = work / 'interaction-unsigned.apk'
    command([zipalign, '-f', '4', unsigned, aligned], 'Test APK alignment', env)
    if not args.run:
        print(json.dumps({'built': True, 'signed': False, 'emulatorTouched': False, 'apk': str(aligned)}))
        return 0

    signer = tool_file(build_tools / 'apksigner', 'apksigner')
    signed = work / 'interaction-signed.apk'
    command([signer, 'sign', '--ks', os.environ['TAVERN_KEYSTORE_FILE'],
             '--ks-key-alias', os.environ['TAVERN_KEY_ALIAS'],
             '--ks-pass', 'env:TAVERN_KEYSTORE_PASSWORD', '--key-pass', 'env:TAVERN_KEY_PASSWORD',
             '--out', signed, aligned], 'Test APK signing', env)
    command([signer, 'verify', '--verbose', signed], 'Test APK signature verification', env)
    configured_report = os.environ.get('TAVERN_INTERACTION_REPORT')
    report_path = Path(configured_report).resolve() if configured_report else work / 'report.json'
    try:
        report_stream = report_path.open('x', encoding='utf-8')
    except OSError:
        raise Failure('Report path must have an existing parent and must not already exist') from None
    installed = False
    report = {'passed': False}
    failure = None
    try:
        command([adb, '-s', serial, 'install', '-t', signed], 'Test APK installation', env)
        installed = True
        instrument = [adb, '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
                      '-e', 'disposable', '1']
        if os.environ.get('TAVERN_INTERACTION_ONBOARDING') == '1':
            instrument += ['-e', 'allowOnboarding', '1']
        if os.environ.get('TAVERN_INTERACTION_CLIPBOARD_CONSENT') == '1':
            instrument += ['-e', 'allowClipboardConsent', '1']
        instrument.append(COMPONENT)
        result = command(instrument, 'Native instrumentation', env,
                         timeout=150, allow_failure=True)
        report = parse_instrumentation(result.stdout)
        if result.returncode:
            report['passed'] = False
            report['instrumentationCommandSucceeded'] = False
    except Failure as error:
        failure = str(error)
        report['passed'] = False
        report['runnerFailure'] = True
    finally:
        if installed:
            try:
                removed = command([adb, '-s', serial, 'uninstall', TEST_PACKAGE],
                                  'Owned test package cleanup', env, allow_failure=True)
                report['ownedTestPackageRemoved'] = removed.returncode == 0 and removed.stdout.strip() == 'Success'
            except Failure:
                report['ownedTestPackageRemoved'] = False
            if not report['ownedTestPackageRemoved']:
                report['passed'] = False
            # Ending instrumentation can end its target VM. Restore the app's
            # availability; this is not a claim that an unsaved draft survives
            # that VM boundary (Java restores only within the test run).
            try:
                relaunched = command([adb, '-s', serial, 'shell', 'am', 'start', '-W',
                                      '-n', TARGET_PACKAGE + '/.MainActivity'],
                                     'Target activity relaunch', env, timeout=45, allow_failure=True)
                report['targetActivityRelaunched'] = (relaunched.returncode == 0
                    and re.search(r'^Status:\s*ok\s*$', relaunched.stdout, re.MULTILINE) is not None)
            except Failure:
                report['targetActivityRelaunched'] = False
            if not report['targetActivityRelaunched']:
                report['passed'] = False
        report['atUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report['device'] = serial
        report['scope'] = 'Native Android instrumentation on an explicitly disposable emulator; no physical-device guarantee.'
        json.dump(report, report_stream, indent=2)
        report_stream.write('\n')
        report_stream.close()
    output = {'passed': report['passed'], 'reportPath': str(report_path),
              'ownedTestPackageRemoved': report.get('ownedTestPackageRemoved', False)}
    if failure:
        output['error'] = failure
    print(json.dumps(output))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Failure as error:
        print(json.dumps({'passed': False, 'error': str(error)}))
        sys.exit(1)
