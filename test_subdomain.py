import os
import shutil
import unittest
from app import app, DEPLOYMENTS_DIR, CLOUDFLARE_DOMAIN

class TestSubdomainRouting(unittest.TestCase):
    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True

        # Create a mock deployment directory
        self.project_name = 'test-project'
        self.site_dir = os.path.join(DEPLOYMENTS_DIR, self.project_name)
        os.makedirs(self.site_dir, exist_ok=True)

        # Create a mock index.html file
        self.index_path = os.path.join(self.site_dir, 'index.html')
        with open(self.index_path, 'w') as f:
            f.write('<h1>Test Deployment</h1>')

    def tearDown(self):
        # Clean up the mock deployment directory
        if os.path.exists(self.site_dir):
            shutil.rmtree(self.site_dir)

    def test_root_domain_routing(self):
        # Request to the root domain should serve the dashboard
        response = self.app.get('/')
        # It shouldn't return the project content
        self.assertNotIn(b'Test Deployment', response.data)

    def test_subdomain_routing(self):
        # Request to the project subdomain should serve the project's index.html
        headers = {'Host': f'{self.project_name}.{CLOUDFLARE_DOMAIN}'}
        response = self.app.get('/', headers=headers)

        # It should return the project content
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Test Deployment', response.data)

    def test_subdomain_routing_with_path(self):
        # Create a mock file in the deployment directory
        test_file_path = os.path.join(self.site_dir, 'test.txt')
        with open(test_file_path, 'w') as f:
            f.write('Test File Content')

        # Request to the project subdomain with a path should serve the file
        headers = {'Host': f'{self.project_name}.{CLOUDFLARE_DOMAIN}'}
        response = self.app.get('/test.txt', headers=headers)

        # It should return the file content
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b'Test File Content')

    def test_non_existent_subdomain(self):
        # Request to a non-existent subdomain should fallback to normal routing
        headers = {'Host': f'non-existent.{CLOUDFLARE_DOMAIN}'}
        response = self.app.get('/', headers=headers)

        # It shouldn't return the project content, but fallback to the dashboard
        self.assertNotIn(b'Test Deployment', response.data)

if __name__ == '__main__':
    unittest.main()
