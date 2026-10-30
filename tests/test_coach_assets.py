from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
COACH = ROOT / "coach"


class CoachAssetTests(unittest.TestCase):
    def test_skill_has_openclaw_frontmatter_and_four_workflows(self):
        skill = (COACH / "SKILL.md").read_text(encoding="utf-8")

        self.assertTrue(skill.startswith("---\n"))
        self.assertIn("name: garmin-training-coach", skill)
        self.assertIn("description: Use when", skill)
        for workflow in ["上午恢复报告", "睡前训练复盘", "备赛计划制定与调整", "具体活动分析"]:
            self.assertIn(workflow, skill)

    def test_skill_requires_confirmation_before_long_term_plan_changes(self):
        skill = (COACH / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("修改长期计划前必须得到用户确认", skill)
        self.assertIn("展示计划差异", skill)
        self.assertIn("MCP 只提供数据", skill)
        self.assertIn("Claw", skill)

    def test_skill_uses_installed_relative_templates_and_absolute_script_path(self):
        skill = (COACH / "SKILL.md").read_text(encoding="utf-8")

        self.assertNotIn("coach/templates/", skill)
        self.assertIn("templates/morning.md", skill)
        self.assertIn("templates/evening.md", skill)
        self.assertIn("/srv/garmin-connect-mcp/scripts/notify_email.py", skill)
        self.assertTrue((COACH / "templates" / "morning.md").is_file())
        self.assertTrue((COACH / "templates" / "evening.md").is_file())

    def test_morning_and_evening_templates_have_report_slots(self):
        morning = (COACH / "templates" / "morning.md").read_text(encoding="utf-8")
        evening = (COACH / "templates" / "evening.md").read_text(encoding="utf-8")

        for template in [morning, evening]:
            self.assertIn("{{report_id}}", template)
            self.assertIn("{{date}}", template)
            self.assertIn("{{summary}}", template)
            self.assertIn("{{data_quality}}", template)
        self.assertIn("恢复", morning)
        self.assertIn("复盘", evening)

    def test_example_yaml_files_contain_no_credentials(self):
        profile = (COACH / "profile.example.yaml").read_text(encoding="utf-8")
        plan = (COACH / "plan.example.yaml").read_text(encoding="utf-8")

        self.assertIn("timezone:", profile)
        self.assertIn("goal:", plan)
        for contents in [profile, plan]:
            lowered = contents.lower()
            self.assertNotIn("api_key", lowered)
            self.assertNotIn("access_token", lowered)
            self.assertNotIn("smtp_password", lowered)
            self.assertNotIn("garmin_password", lowered)


if __name__ == "__main__":
    unittest.main()
