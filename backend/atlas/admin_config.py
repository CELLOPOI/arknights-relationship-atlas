from django.contrib.admin.apps import AdminConfig


class AtlasAdminConfig(AdminConfig):
    default_site = "atlas.admin_site.AtlasAdminSite"
