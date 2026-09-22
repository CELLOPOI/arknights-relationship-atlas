from django.db import migrations
from django.forms.models import model_to_dict


def assign_rhodes(apps, schema_editor):
    Person = apps.get_model("atlas", "Person")
    Faction = apps.get_model("atlas", "Faction")
    Revision = apps.get_model("atlas", "Revision")
    alias = schema_editor.connection.alias
    if not Faction.objects.using(alias).filter(pk="rhodes").exists():
        # 新库之后导入已修正的快照；此迁移只修复已有的未归属记录。
        return
    ids = (
        "char_508_aguard",
        "char_509_acast",
        "char_510_amedic",
        "char_511_asnipe",
        "char_513_apionr",
        "char_615_acspec",
    )
    for person in Person.objects.using(alias).select_for_update().filter(id__in=ids, faction_id="unknown"):
        before = model_to_dict(person)
        person.faction_id = "rhodes"
        person.version += 1
        person.save(using=alias, update_fields=["faction", "version", "updated_at"])
        Revision.objects.using(alias).create(
            target_type="person",
            target_id=person.pk,
            before=before,
            after=model_to_dict(person),
            reason="faction-correction:rhodes-elites:2026-09-18",
        )


class Migration(migrations.Migration):
    dependencies = [("atlas", "0001_initial")]
    # 回退程序版本不撤销已确认的资料归属，也不覆盖后续的人工编辑。
    operations = [migrations.RunPython(assign_rhodes, migrations.RunPython.noop)]
