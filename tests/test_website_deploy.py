import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('activate', Path(__file__).parents[1] / 'scripts/activate-website.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeploymentTests(unittest.TestCase):
    def bundle(self, folder, name, broken=False, unsafe=False):
        target = folder / (name + '.tar.gz')
        files = {'index.html': b'hello', 'release.json': b'{}', 'style.css': b'body{}', 'app.js': b'void 0'}
        manifest = {key: hashlib.sha256(value).hexdigest() for key, value in files.items()}
        if broken:
            files['index.html'] = b'corrupted'
        files['manifest.json'] = json.dumps(manifest).encode()
        if unsafe:
            files['../escape'] = b'bad'
        with tarfile.open(target, 'w:gz') as archive:
            for path, data in files.items():
                info = tarfile.TarInfo(path)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return target

    def test_activation_integrity_and_retention(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for i in range(4):
                module.activate(root, f'good-{i}', self.bundle(root, f'good-{i}'))
            self.assertEqual((root / 'current').resolve().name, 'good-3')
            self.assertEqual(len(list((root / 'releases').iterdir())), 3)
            for name, broken, unsafe in [('bad-hash', True, False), ('bad-path', False, True)]:
                with self.assertRaises(ValueError):
                    module.activate(root, name, self.bundle(root, name, broken, unsafe))
                self.assertEqual((root / 'current').resolve().name, 'good-3')


if __name__ == '__main__':
    unittest.main()
