import importlib.util
import unittest
from pathlib import Path

module_path = Path(__file__).parents[3] / 'data/tools/import-sunny-job-search-xlsx.py'
spec = importlib.util.spec_from_file_location('sunny_importer', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PriorityNormalizationTests(unittest.TestCase):
    def test_low_priority_label_wins_before_its_priority_substring(self):
        self.assertEqual(module.priority('較低優先投遞', 70), ('low', '低優先'))

if __name__ == '__main__': unittest.main()
