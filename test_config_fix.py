import os
import json
import logging
import tempfile
import shutil
import unittest

# Import the function to test (assuming app.py is in the same directory)
from app import fix_commonjs_config_files

# Mock logger to suppress output during tests
logging.basicConfig(level=logging.ERROR)

class TestConfigFix(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory
        self.test_dir = tempfile.mkdtemp()

    def tearDown(self):
        # Remove the temporary directory after the test
        shutil.rmtree(self.test_dir)

    def test_renames_postcss_config_when_esm(self):
        # Create package.json with "type": "module"
        package_json_content = {
            "name": "test-project",
            "type": "module"
        }
        with open(os.path.join(self.test_dir, "package.json"), "w") as f:
            json.dump(package_json_content, f)

        # Create postcss.config.js with CommonJS syntax
        postcss_content = "module.exports = { plugins: {} };"
        with open(os.path.join(self.test_dir, "postcss.config.js"), "w") as f:
            f.write(postcss_content)

        # Run the fix function
        fix_commonjs_config_files(self.test_dir)

        # Check if the file was renamed
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, "postcss.config.js")))
        self.assertTrue(os.path.exists(os.path.join(self.test_dir, "postcss.config.cjs")))

        # Check content is preserved
        with open(os.path.join(self.test_dir, "postcss.config.cjs"), "r") as f:
            content = f.read()
        self.assertEqual(content, postcss_content)

    def test_does_not_rename_if_not_esm(self):
        # Create package.json WITHOUT "type": "module"
        package_json_content = {
            "name": "test-project",
            "type": "commonjs"
        }
        with open(os.path.join(self.test_dir, "package.json"), "w") as f:
            json.dump(package_json_content, f)

        # Create postcss.config.js with CommonJS syntax
        postcss_content = "module.exports = { plugins: {} };"
        with open(os.path.join(self.test_dir, "postcss.config.js"), "w") as f:
            f.write(postcss_content)

        # Run the fix function
        fix_commonjs_config_files(self.test_dir)

        # Check that the file was NOT renamed
        self.assertTrue(os.path.exists(os.path.join(self.test_dir, "postcss.config.js")))
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, "postcss.config.cjs")))

    def test_does_not_rename_if_esm_syntax(self):
        # Create package.json with "type": "module"
        package_json_content = {
            "name": "test-project",
            "type": "module"
        }
        with open(os.path.join(self.test_dir, "package.json"), "w") as f:
            json.dump(package_json_content, f)

        # Create postcss.config.js with ESM syntax
        postcss_content = "export default { plugins: {} };"
        with open(os.path.join(self.test_dir, "postcss.config.js"), "w") as f:
            f.write(postcss_content)

        # Run the fix function
        fix_commonjs_config_files(self.test_dir)

        # Check that the file was NOT renamed
        self.assertTrue(os.path.exists(os.path.join(self.test_dir, "postcss.config.js")))
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, "postcss.config.cjs")))

    def test_renames_tailwind_config_too(self):
        # Create package.json with "type": "module"
        package_json_content = {
            "name": "test-project",
            "type": "module"
        }
        with open(os.path.join(self.test_dir, "package.json"), "w") as f:
            json.dump(package_json_content, f)

        # Create tailwind.config.js with CommonJS syntax
        tailwind_content = "module.exports = { content: [] };"
        with open(os.path.join(self.test_dir, "tailwind.config.js"), "w") as f:
            f.write(tailwind_content)

        # Run the fix function
        fix_commonjs_config_files(self.test_dir)

        # Check if the file was renamed
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, "tailwind.config.js")))
        self.assertTrue(os.path.exists(os.path.join(self.test_dir, "tailwind.config.cjs")))

if __name__ == "__main__":
    unittest.main()
