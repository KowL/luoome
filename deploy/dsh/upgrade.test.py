import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('upgrade.py')
spec = importlib.util.spec_from_file_location('luoome_upgrade', source)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class ReleaseBundleTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / 'dsh-20261028T000000Z'
        deploy = self.root / 'deploy/dsh'
        deploy.mkdir(parents=True)
        for name in upgrade.DEPLOY_FILES:
            shutil.copy2(source.parent / name, deploy / name)
        metadata = json.dumps({'dependencies': {
            '@deepseek-ai/dsh-client-connection': '0.2.1-rc.2',
        }}).encode()
        with tarfile.open(self.root / 'dsh-luoome.tgz', 'w:gz') as package:
            entry = tarfile.TarInfo('package/package.json')
            entry.size = len(metadata)
            package.addfile(entry, io.BytesIO(metadata))
        self.manifest = upgrade.make_manifest(self.root, 'fixture-revision')
        self.save_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def save_manifest(self):
        (self.root / 'release-manifest.json').write_text(json.dumps(self.manifest))

    def test_current_checkout_files_are_bound_to_the_artifact(self):
        result = upgrade.validate_bundle(self.root)
        self.assertEqual(result['files']['deploy/dsh/entrypoint.sh'],
                         upgrade.digest(source.with_name('entrypoint.sh')))

    def test_old_listener_configuration_is_rejected_even_with_matching_checksums(self):
        entrypoint = self.root / 'deploy/dsh/entrypoint.sh'
        entrypoint.write_text(entrypoint.read_text().replace('--host 127.0.0.1', '--host "$DSH_BIND_HOST"'))
        self.manifest['files']['deploy/dsh/entrypoint.sh'] = upgrade.digest(entrypoint)
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, 'Pocket deployment contract'):
            upgrade.validate_bundle(self.root)

    def test_unexpected_private_files_are_rejected(self):
        (self.root / 'deploy/dsh/.env').write_text('fixture only')
        with self.assertRaisesRegex(RuntimeError, 'Unexpected deployment file'):
            upgrade.validate_bundle(self.root)

    def test_delivery_progress_can_advance_but_task_definition_changes_are_detected(self):
        home = Path(self.temporary.name) / 'dsh-home'
        (home / 'storages').mkdir(parents=True)
        task = {'record': {'id': 'fixture', 'kind': 'cron', 'title': 'fixture',
                           'prompt': 'fixture', 'expression': '0 8 * * 1-5',
                           'timeZone': 'Asia/Shanghai', 'scheduledAt': '2026-10-27T00:00:00Z'},
                'sessionId': 'fixture-session', 'status': 'active',
                'deliveryHistory': [], 'lastDelivery': None}
        path = home / 'storages/schedule.json'

        def save():
            path.write_text(json.dumps({'tables': {'tasks': {'fixture': task}}}))

        save()
        before = upgrade.schedules(home)
        task['record']['scheduledAt'] = '2026-10-28T00:00:00Z'
        task['lastDelivery'] = {'scheduledAt': '2026-10-27T00:00:00Z'}
        task['deliveryHistory'].append(task['lastDelivery'])
        save()
        self.assertEqual(upgrade.schedules(home), before)
        task['record']['expression'] = '0 9 * * 1-5'
        save()
        self.assertNotEqual(upgrade.schedules(home), before)
        task['record']['expression'] = '0 8 * * 1-5'
        task['status'] = 'inactive'
        save()
        self.assertNotEqual(upgrade.schedules(home), before)

    def test_bundle_normalizes_private_checkout_modes_and_packs_outside_the_repo(self):
        repo = Path(self.temporary.name) / 'checkout'
        deploy = repo / 'deploy/dsh'
        shutil.copytree(self.root / 'deploy/dsh', deploy)
        (deploy / 'profile-seed.mjs').chmod(0o600)
        (repo / '.env').write_text('private fixture')
        package = repo / 'packages/dsh-luoome'
        package.mkdir(parents=True)
        metadata = {'name': 'dsh-luoome', 'version': '0.2.3',
                    'files': ['dist/host.js'], 'dependencies': {
            '@deepseek-ai/dsh-client-connection': '0.2.1-rc.2',
        }, 'devDependencies': {'@luoome/core': 'workspace:*'}}
        (package / 'package.json').write_text(json.dumps(metadata))
        for name in ['README.md', 'LICENSE', 'dist/host.js']:
            path = package / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('public fixture')
        core = repo / 'packages/core'
        core.mkdir()
        (core / 'package.json').write_text(json.dumps({'name': '@luoome/core', 'version': '1.0.0'}))
        destination = repo / '.tmp/dsh-20261028T000001Z'

        def command(args, **kwargs):
            if 'pack' not in args:
                return
            stage = Path(kwargs['cwd'])
            self.assertNotIn(repo, stage.parents)
            self.assertFalse((stage / '.env').exists())
            staged_metadata = json.loads((stage / 'package.json').read_text())
            self.assertEqual(staged_metadata['devDependencies']['@luoome/core'], '1.0.0')
            with tarfile.open(destination / 'dsh-luoome-0.2.3.tgz', 'w:gz') as archive:
                for path in stage.rglob('*'):
                    if path.is_file():
                        archive.add(path, arcname='package/' + str(path.relative_to(stage)))

        with patch.object(upgrade, '__file__', str(deploy / 'upgrade.py')), \
                patch.object(upgrade, 'run', side_effect=command), \
                patch.object(upgrade, 'output', return_value='fixture-revision'), \
                patch('builtins.print'):
            upgrade.bundle(destination)
        for name in upgrade.DEPLOY_FILES:
            expected = 0o755 if name == 'entrypoint.sh' else 0o644
            self.assertEqual((destination / 'deploy/dsh' / name).stat().st_mode & 0o777, expected)
        upgrade.validate_bundle(destination)


if __name__ == '__main__':
    unittest.main()
