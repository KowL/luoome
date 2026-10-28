#!/usr/bin/env python3
"""Build a release bundle from this checkout, then apply that bundle on the Docker host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile

DEPLOY_FILES = [
    'Caddyfile', 'Dockerfile', 'compose.yaml', 'entrypoint.sh', 'profile-seed.mjs',
    'pocket-prefix.mjs', 'dsh-web-probe.mjs', 'production.env.example', 'upgrade.py',
]
CONTAINER = 'luoome-dsh-dsh-web-1'
BUSINESS_TABLES = [
    'accounts', 'holdings', 'trades', 'advices', 'decision_reviews',
    'decision_review_revisions', 'reports', 'strategies', 'strategy_versions',
    'strategy_runs', 'strategy_results', 'strategy_research_states',
    'watchlists', 'watchlist_items', 'alert_plans',
]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def make_manifest(root, revision):
    with tarfile.open(root / 'dsh-luoome.tgz') as package:
        metadata = json.load(package.extractfile('package/package.json'))
    files = ['deploy/dsh/' + name for name in DEPLOY_FILES] + ['dsh-luoome.tgz']
    return {
        'format': 1, 'release': root.name, 'sourceRevision': revision,
        'dshVersion': metadata['dependencies']['@deepseek-ai/dsh-client-connection'],
        'files': {name: digest(root / name) for name in files},
    }


def validate_bundle(root):
    manifest = json.loads((root / 'release-manifest.json').read_text())
    if manifest['format'] != 1 or not re.fullmatch(r'dsh-\d{8}T\d{6}Z', root.name):
        raise RuntimeError('Invalid release bundle')
    expected = {'deploy/dsh/' + name for name in DEPLOY_FILES} | {'dsh-luoome.tgz'}
    allowed_root = {'deploy', 'dsh-luoome.tgz', 'release-manifest.json',
                    'Dockerfile.release', 'deployment-result.json'}
    if any(path.name not in allowed_root for path in root.iterdir()):
        raise RuntimeError('Unexpected file in release bundle')
    if {path.name for path in (root / 'deploy/dsh').iterdir()} != set(DEPLOY_FILES):
        raise RuntimeError('Unexpected deployment file in release bundle')
    if set(manifest['files']) != expected or manifest['release'] != root.name:
        raise RuntimeError('Incomplete release bundle')
    for name in expected:
        if (root / name).is_symlink():
            raise RuntimeError('Release files must not be symlinks')
        if digest(root / name) != manifest['files'][name]:
            raise RuntimeError('Release checksum mismatch: ' + name)
    rules = {
        'entrypoint.sh': ['--host 127.0.0.1', '--pocket /usr/local/lib/node_modules/dsh-pocket'],
        'compose.yaml': ['DSH_BIND_HOST: 127.0.0.1', 'dsh-web-probe.mjs', '--health'],
        'Caddyfile': ['handle_path /dsh/*', 'reverse_proxy dsh-web:3081'],
        'profile-seed.mjs': ["const POCKET_NAME = 'dsh-pocket'"],
    }
    for name, required in rules.items():
        text = (root / 'deploy/dsh' / name).read_text()
        if any(value not in text for value in required):
            raise RuntimeError('Pocket deployment contract missing from ' + name)
    return manifest


def bundle(destination):
    repo = Path(__file__).resolve().parents[2]
    destination.mkdir(parents=True)
    run(['bun', '--no-env-file', 'run', 'build:dsh-luoome'], cwd=repo)
    package = repo / 'packages/dsh-luoome'
    metadata = json.loads((package / 'package.json').read_text())
    versions = {entry['name']: entry['version'] for entry in (
        json.loads(path.read_text()) for path in (repo / 'packages').glob('*/package.json'))}
    for name, version in metadata['devDependencies'].items():
        if version == 'workspace:*':
            metadata['devDependencies'][name] = versions[name]
    # Bun pm pack still searches ancestors for .env; stage only public package files elsewhere.
    with tempfile.TemporaryDirectory(prefix='luoome-pack-') as temporary:
        stage = Path(temporary)
        (stage / 'package.json').write_text(json.dumps(metadata, indent=2) + '\n')
        for name in metadata['files'] + ['README.md', 'LICENSE']:
            source = package / name
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        run(['bun', '--no-env-file', 'pm', 'pack', '--destination', str(destination)], cwd=stage)
    packages = list(destination.glob('dsh-luoome-*.tgz'))
    if len(packages) != 1:
        raise RuntimeError('Expected one freshly built luoome artifact')
    packages[0].rename(destination / 'dsh-luoome.tgz')
    target = destination / 'deploy/dsh'
    target.mkdir(parents=True)
    for name in DEPLOY_FILES:
        shutil.copy2(Path(__file__).resolve().parent / name, target / name)
        (target / name).chmod(0o755 if name == 'entrypoint.sh' else 0o644)
    manifest = make_manifest(destination, output(['git', '-C', str(repo), 'rev-parse', 'HEAD']))
    (destination / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    validate_bundle(destination)
    print(json.dumps({'bundle': str(destination), 'release': destination.name,
                      'pluginSha256': manifest['files']['dsh-luoome.tgz']}))


def facts(path):
    connection = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
    try:
        tables = {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
        return {
            name: hashlib.sha256('\n'.join(sorted(
                json.dumps(row, default=str, ensure_ascii=False)
                for row in connection.execute('select * from "' + name + '"')
            )).encode()).hexdigest()
            for name in BUSINESS_TABLES if name in tables
        }
    finally:
        connection.close()


def schedules(home):
    data = json.loads((home / 'storages/schedule.json').read_text())
    definitions = {}
    for identity, task in data['tables']['tasks'].items():
        record = dict(task['record'])
        # Recurring scheduledAt advances when DSH delivers overdue reminders after restart.
        if record['kind'] in {'every', 'daily', 'weekly', 'cron'}:
            record.pop('scheduledAt', None)
        definitions[identity] = {'record': record, 'sessionId': task['sessionId'],
                                 'status': task['status']}
    return hashlib.sha256(json.dumps(definitions, sort_keys=True).encode()).hexdigest()


def apply(root, env_file, caddy_env):
    manifest = validate_bundle(root)
    current = json.loads(output(['docker', 'inspect', CONTAINER]))[0]
    previous_config = current['Config']['Labels']['com.docker.compose.project.config_files']
    if ',' in previous_config:
        raise RuntimeError('Multiple Compose files require an explicit deployment review')
    base_image = current['Config']['Image']
    old_release = re.search(r'^LUOOME_RELEASE=(.+)$', env_file.read_text(), re.M)
    if old_release is None or base_image != 'luoome-dsh:' + old_release.group(1).strip():
        raise RuntimeError('Running image and deployment env disagree; nothing was changed')
    release_image = 'luoome-dsh:' + manifest['release']
    if base_image == release_image:
        raise RuntimeError('This immutable release is already running')
    mounts = {entry['Destination']: Path(entry['Source']) for entry in current['Mounts']}
    home = mounts['/var/lib/dsh']
    database = mounts['/var/lib/luoome'] / 'luoome.db'
    if shutil.disk_usage(root).free < database.stat().st_size + 256 * 1024 * 1024:
        raise RuntimeError('Insufficient disk space for a consistent backup; nothing was stopped')
    runtime_version = output(['docker', 'exec', CONTAINER, 'node', '-p',
                              'require("/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json").version'])
    if runtime_version != manifest['dshVersion']:
        raise RuntimeError('DSH SDK changed; build the full runtime Dockerfile before upgrading')
    compose_file = root / 'deploy/dsh/compose.yaml'

    def compose(path):
        return ['docker', 'compose', '-p', 'luoome-dsh', '-f', str(path),
                '--env-file', str(env_file), '--env-file', str(caddy_env)]

    # Only the runtime image is inherited. Every deployment file comes from this bundle.
    dockerfile = root / 'Dockerfile.release'
    dockerfile.write_text('FROM ' + base_image + '''
USER root
COPY deploy/dsh /app/deploy/dsh
COPY dsh-luoome.tgz /app/plugin/dsh-luoome.tgz
RUN node -e 'const fs=require("node:fs");const p="/usr/local/lib/node_modules/dsh-pocket/";if(require(p+"package.json").version!=="2.12.0"||!fs.readFileSync(p+"lib/proxy.mjs","utf8").includes("prefixPocketResponse(res)"))throw Error("Pocket runtime requires a full image rebuild")'
RUN chmod -R a+rX /app/deploy/dsh /app/plugin && chmod 755 /app/deploy/dsh/entrypoint.sh
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD ["node", "/app/deploy/dsh/dsh-web-probe.mjs", "--health"]
USER 1000:1000
''')
    run(['docker', 'build', '-f', str(dockerfile), '-t', release_image, str(root)])
    backup = root.parent.parent / 'backups' / ('before-' + root.name)
    backup.mkdir(mode=0o700)
    for source, name in [(env_file, 'production.env'), (caddy_env, 'caddy.env')]:
        shutil.copy2(source, backup / name)
        os.chmod(backup / name, 0o600)
    env_text = env_file.read_text()
    for key, value in [('LUOOME_RELEASE', root.name), ('DSH_BIND_HOST', '127.0.0.1')]:
        if re.search(r'^' + key + '=', env_text, re.M):
            env_text = re.sub(r'^' + key + '=.*$', key + '=' + value, env_text, flags=re.M)
        else:
            env_text += '\n' + key + '=' + value + '\n'
    stopped = False
    caddy_changed = False
    try:
        # Resolve configuration before stopping the current service; never print private env values.
        env_file.write_text(env_text)
        resolved = json.loads(output(compose(compose_file) + ['config', '--format', 'json']))
        web = resolved['services']['dsh-web']
        if web['environment']['DSH_BIND_HOST'] != '127.0.0.1' or web.get('ports'):
            raise RuntimeError('Resolved Compose violates the Pocket listener contract')
        caddy = json.loads(output(['docker', 'inspect', 'luoome-dsh-caddy-1']))[0]
        old_caddy = next(Path(entry['Source']) for entry in caddy['Mounts']
                         if entry['Destination'] == '/etc/caddy/Caddyfile')
        caddy_changed = digest(old_caddy) != digest(root / 'deploy/dsh/Caddyfile')
        if caddy_changed:
            run(['docker', 'run', '--rm', '-e', 'DSH_PUBLIC_IP=' + resolved['services']['caddy']['environment']['DSH_PUBLIC_IP'],
                 '-v', str(root / 'deploy/dsh/Caddyfile') + ':/etc/caddy/Caddyfile:ro',
                 '--entrypoint', 'caddy', caddy['Image'], 'validate', '--config', '/etc/caddy/Caddyfile'])
        run(['docker', 'stop', '--time', '120', CONTAINER], stdout=subprocess.DEVNULL)
        stopped = True
        before = facts(database)
        schedule_hash = schedules(home)
        source = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True)
        snapshot = sqlite3.connect(backup / 'luoome.db')
        try:
            source.backup(snapshot)
            if snapshot.execute('pragma integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
        finally:
            source.close()
            snapshot.close()
        os.chmod(backup / 'luoome.db', 0o600)

        def selected(entry):
            if any(part in {'node_modules', 'logs', 'cache', '.cache', 'artifacts'}
                   for part in Path(entry.name).parts) or entry.name.endswith('.tgz'):
                return None
            return entry

        with tarfile.open(backup / 'dsh-home.tar.gz', 'w:gz', dereference=False) as archive:
            archive.add(home, arcname='dsh-home', filter=selected)
        os.chmod(backup / 'dsh-home.tar.gz', 0o600)
        baseline = {'business': before, 'schedules': schedule_hash, 'previousCompose': previous_config}
        (backup / 'manifest.json').write_text(json.dumps(baseline, indent=2))
        os.chmod(backup / 'manifest.json', 0o600)
        services = ['dsh-web', 'caddy'] if caddy_changed else ['dsh-web']
        run(compose(compose_file) + ['up', '--wait', '--wait-timeout', '90', '--no-build',
                                    '--pull', 'never', '--no-deps'] + services)
        probe = (root / 'deploy/dsh/dsh-web-probe.mjs').read_text() + '''
console.log(JSON.stringify(await probePocket(process.env.DSH_PUBLIC_URL, readFileSync(process.env.DSH_HOME + '/dsh-pocket/token', 'utf8').trim())));
'''
        run(['docker', 'exec', '-i', CONTAINER, 'node', '--input-type=module'], input=probe, text=True)
        if facts(database) != before:
            raise RuntimeError('Business facts changed during upgrade')
        if schedules(home) != schedule_hash:
            raise RuntimeError('Schedule definitions changed during upgrade')
        result = {'release': root.name, 'image': output(['docker', 'inspect', CONTAINER, '--format', '{{.Image}}']),
                  'backup': str(backup), 'healthy': True, 'authenticatedProbe': True,
                  'businessFactsUnchanged': True, 'schedulesUnchanged': True}
        (root / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except BaseException:
        # Preserve startup evidence privately before Compose removes the failed container.
        with (backup / 'failed-container.log').open('w') as diagnostic:
            os.chmod(diagnostic.name, 0o600)
            subprocess.run(['docker', 'logs', '--tail', '200', CONTAINER],
                           stdout=diagnostic, stderr=diagnostic, check=False)
        shutil.copy2(backup / 'production.env', env_file)
        if stopped:
            services = ['dsh-web', 'caddy'] if caddy_changed else ['dsh-web']
            run(compose(previous_config) + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps'] + services)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    package = sub.add_parser('bundle')
    package.add_argument('--output', type=Path, required=True)
    sub.add_parser('verify')
    deploy = sub.add_parser('apply')
    deploy.add_argument('--env', type=Path, default=Path('/opt/luoome/dsh/production.env'))
    deploy.add_argument('--caddy-env', type=Path, default=Path('/opt/luoome/config/caddy-dsh.env'))
    args = parser.parse_args()
    if args.mode == 'bundle':
        bundle(args.output.resolve())
    else:
        root = Path(__file__).resolve().parents[2]
        if args.mode == 'verify':
            result = validate_bundle(root)
            print(json.dumps({'release': result['release'], 'verified': True}))
        else:
            apply(root, args.env.resolve(), args.caddy_env.resolve())


if __name__ == '__main__':
    main()
