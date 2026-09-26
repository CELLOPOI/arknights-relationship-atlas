from django.contrib import admin
from django.urls import include, path

from atlas import views
from atlas.feedback_views import FeedbackView
from atlas.ops_views import ReadyView
from atlas.site_config_views import SiteConfigView
from atlas.update_views import SiteUpdatePreviewView, SiteUpdatesView

urlpatterns = [
    path("api/updates/", SiteUpdatesView.as_view()),
    path("api/updates/<int:pk>/preview/", SiteUpdatePreviewView.as_view()),
    path("api/preferences/", include("atlas.preference_views")),
    path("admin/", admin.site.urls),
    path("api/feedback/", FeedbackView.as_view()),
    path("api/health/", views.HealthView.as_view()),
    path("api/ready/", ReadyView.as_view()),
    path("api/site-config/", SiteConfigView.as_view()),
    path("api/graph/", views.GraphView.as_view()),
    path("api/people/<str:pk>/", views.PersonView.as_view()),
    path("api/relationships/<str:pk>/", views.RelationshipView.as_view()),
    path("api/session/", views.SessionView.as_view()),
    path("api/auth/<str:action>/", views.AuthView.as_view()),
    path("api/favorites/", views.FavoritesView.as_view()),
    path("api/comments/", views.CommentsView.as_view()),
    path("api/comments/<int:pk>/", views.CommentView.as_view()),
    path("api/comments/<int:pk>/report/", views.ReportView.as_view()),
    path("api/submissions/", views.SubmissionsView.as_view()),
]
