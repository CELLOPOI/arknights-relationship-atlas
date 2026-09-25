import logging
from smtplib import SMTPException

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core import signing
from django.core.mail import send_mail
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Comment, Favorite, Identity, Person, Relationship, Report, Submission, User
from .public_cache import encode_json, public_json
from .public_data import consistent_read, release_metadata
from .source_data import digest
from .source_titles import describe_source
from .throttles import AuthThrottle

logger = logging.getLogger(__name__)


class AtlasAPIView(APIView):
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not isinstance(request.data, dict):
            raise ValidationError("请求内容必须是字段对象。")


def require_community():
    if not settings.COMMUNITY_ENABLED:
        raise PermissionDenied({"detail": "账号社区暂未开放。", "code": "community_disabled"})


class CommunityAPIView(AtlasAPIView):
    def check_permissions(self, request):
        # 在读取目标、解析正文或执行写入之前拒绝旧社区请求，包括已有会话。
        require_community()
        super().check_permissions(request)


def user_data(user):
    return {"id": user.pk, "username": user.username, "email": user.email, "isStaff": user.is_staff}


def public_people():
    return Person.objects.filter(published=True).select_related("faction")


def public_relationships():
    return Relationship.objects.filter(
        published=True, person_a__published=True, person_b__published=True
    ).select_related("person_a", "person_b")


def person_data(person):
    return {
        "id": person.id,
        "name": person.name,
        "aliases": person.aliases,
        "factionId": person.faction_id,
        "factionName": person.faction.name,
        "isOperator": person.is_operator,
        "avatar": person.avatar or "/avatars/unknown.svg",
        "avatarSource": person.avatar_source,
        "avatarIsGeneric": person.avatar_is_generic,
        "version": person.version,
        **({"groupId": person.group_id, "groupName": person.group_name} if person.group_id else {}),
    }


def edge_data(edge):
    result = {
        "id": edge.id,
        "source": edge.person_a_id,
        "target": edge.person_b_id,
        "kind": edge.kind,
        "stableKeys": edge.stable_keys,
        "version": edge.version,
    }
    if edge.kind == "awareness":
        result.update(
            {
                "from": edge.awareness_from_id,
                "to": edge.person_b_id if edge.awareness_from_id == edge.person_a_id else edge.person_a_id,
            }
        )
    return result


def get_target(data):
    target_type, target_id = data.get("targetType"), data.get("targetId")
    if target_type not in ("person", "relationship") or not isinstance(target_id, str):
        raise ValidationError("请选择有效的人物或关系档案。")
    obj = get_object_or_404(
        public_people() if target_type == "person" else public_relationships(), pk=target_id
    )
    return obj, {target_type: obj}


def target_data(item):
    target = item.target
    visible = target.published and (
        not isinstance(target, Relationship) or (target.person_a.published and target.person_b.published)
    )
    return {
        "targetType": "person" if item.person_id else "relationship",
        "targetId": str(target.pk),
        "title": str(target) if visible else "该档案已撤下",
        "available": visible,
    }


def paginated(request, queryset, render):
    page = serializers.IntegerField(min_value=1, max_value=2147483647).run_validation(
        request.query_params.get("page", "1")
    )
    size = 30
    count = queryset.count()
    return {
        "results": [render(x) for x in queryset[(page - 1) * size : page * size]],
        "count": count,
        "page": page,
        "hasNext": page * size < count,
    }


class GraphView(AtlasAPIView):
    permission_classes = [AllowAny]

    @consistent_read
    def get(self, request):
        scope = request.query_params.get("scope", "operators")
        if scope not in ("operators", "all"):
            raise ValidationError("资料范围无效。")
        release = release_metadata()
        if release and settings.FORMAL_DATA_MANAGED:
            # 在同一只读快照内先核对版本，304 和热缓存不构造人物、关系及完整 JSON。
            key = "graph-v1-" + digest({"scope": scope, "release": release})
            return public_json(request, key, lambda: encode_json(self.payload(scope, release)))
        response = Response(self.payload(scope, release))
        etag = '"' + digest(response.data) + '"'
        if request.headers.get("If-None-Match") == etag:
            response = Response(status=304)
        response["ETag"] = etag
        response["Cache-Control"] = "public, max-age=0, must-revalidate"
        return response

    def payload(self, scope, release):
        people = public_people()
        edges = public_relationships()
        if scope == "operators":
            people = people.filter(is_operator=True)
            edges = edges.filter(person_a__is_operator=True, person_b__is_operator=True)
        people = list(people)
        factions = {
            p.faction_id: {"id": p.faction_id, "name": p.faction.name, "order": p.faction.order}
            for p in people
        }
        return {
            "nodes": [person_data(p) for p in people],
            "edges": [edge_data(e) for e in edges],
            "factions": sorted(factions.values(), key=lambda f: (f["order"], f["id"])),
            "scope": scope,
            "npcCount": public_people().filter(is_operator=False).count(),
            "dataRelease": release,
        }


class PersonView(AtlasAPIView):
    permission_classes = [AllowAny]

    @consistent_read
    def get(self, request, pk):
        identity = Identity.objects.filter(external_id=pk, published=True).first()
        person = get_object_or_404(public_people(), pk=identity.person_id if identity else pk)
        return Response(person_data(person))


class RelationshipView(AtlasAPIView):
    permission_classes = [AllowAny]

    @consistent_read
    def get(self, request, pk):
        edge = get_object_or_404(public_relationships(), pk=pk)
        evidence = list(edge.evidence.filter(published=True).order_by("pk"))
        rendered_evidence = [
            {"id": item.pk, "quote": item.quote, "sources": [describe_source(s) for s in item.sources]}
            for item in evidence
        ]
        return Response(
            {
                **edge_data(edge),
                "title": str(edge),
                "people": [person_data(edge.person_a), person_data(edge.person_b)],
                "note": edge.note,
                "quote": "\n\n".join(e.quote for e in evidence),
                "sources": [s for item in rendered_evidence for s in item["sources"]],
                "evidence": rendered_evidence,
            }
        )


@method_decorator(ensure_csrf_cookie, name="dispatch")
class SessionView(AtlasAPIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response(
            {
                "user": user_data(request.user) if request.user.is_authenticated else None,
                "communityEnabled": settings.COMMUNITY_ENABLED,
                "feedbackEnabled": True,
                "registrationEnabled": settings.COMMUNITY_ENABLED and settings.REGISTRATION_ENABLED,
            }
        )


class Credentials(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(max_length=256, trim_whitespace=False)


class Registration(Credentials):
    email = serializers.EmailField(max_length=254)


def deliver_mail(subject, body, recipient):
    try:
        send_mail(subject, body, settings.DEFAULT_FROM_EMAIL, [recipient])
    except (SMTPException, OSError) as exc:
        logger.error("Account email delivery failed: %s", type(exc).__name__)
        raise ValidationError("邮件暂时无法发送，请稍后重试。") from exc


@method_decorator(csrf_protect, name="dispatch")
class AuthView(AtlasAPIView):
    permission_classes = [AllowAny]
    throttle_classes = [AuthThrottle]

    def check_permissions(self, request):
        # 允许旧会话退出；后台账号登录由 Django admin 独立处理。
        if self.kwargs.get("action") != "logout":
            require_community()
        super().check_permissions(request)

    def post(self, request, action):
        if action == "login":
            fields = Credentials(data=request.data)
            fields.is_valid(raise_exception=True)
            user = authenticate(request, **fields.validated_data)
            if not user:
                raise ValidationError("用户名或密码不正确，或邮箱尚未验证。")
            login(request, user)
            return Response({"user": user_data(user)})
        if action == "logout":
            logout(request)
            return Response({"user": None})
        if action == "register":
            if not settings.REGISTRATION_ENABLED:
                raise PermissionDenied("注册暂未开放。")
            fields = Registration(data=request.data)
            fields.is_valid(raise_exception=True)
            values = fields.validated_data
            user = User(username=values["username"], email=values["email"].lower(), is_active=False)
            validate_password(values["password"], user)
            user.set_password(values["password"])
            user.full_clean()
            try:
                with transaction.atomic():
                    user.save()
                    token = signing.dumps({"uid": user.pk, "email": user.email}, salt="atlas-email")
                    deliver_mail(
                        "验证你的干员关系档案账号",
                        f"请在 24 小时内打开以下链接完成验证：\n{settings.PUBLIC_ORIGIN}/?action=verify&token={token}#home",
                        user.email,
                    )
            except IntegrityError as exc:
                raise ValidationError("用户名或邮箱已被使用。") from exc
            return Response({"detail": "验证邮件已发送，请验证后登录。"}, status=201)
        if action == "verify":
            token = request.data.get("token", "")
            if not isinstance(token, str) or len(token) > 2000:
                raise ValidationError("验证链接无效。")
            try:
                payload = signing.loads(token, salt="atlas-email", max_age=86400)
                user = User.objects.get(pk=payload["uid"], email=payload["email"])
            except (signing.BadSignature, User.DoesNotExist, KeyError, TypeError) as exc:
                raise ValidationError("验证链接无效或已过期，请重新申请验证邮件。") from exc
            if not user.email_verified:
                user.email_verified, user.is_active = True, True
                user.save(update_fields=["email_verified", "is_active"])
            return Response({"detail": "邮箱验证完成，可以登录。"})
        if action in ("forgot", "resend"):
            field = serializers.EmailField()
            email = field.run_validation(request.data.get("email", "")).lower()
            user = User.objects.filter(email=email).first()
            if user and action == "forgot" and user.is_active:
                token = default_token_generator.make_token(user)
                deliver_mail(
                    "重设干员关系档案密码",
                    f"请在一小时内打开以下链接：\n{settings.PUBLIC_ORIGIN}/?action=reset&uid={user.pk}&token={token}#home",
                    user.email,
                )
            if user and action == "resend" and not user.email_verified:
                token = signing.dumps({"uid": user.pk, "email": user.email}, salt="atlas-email")
                deliver_mail(
                    "验证你的干员关系档案账号",
                    f"请在 24 小时内打开：\n{settings.PUBLIC_ORIGIN}/?action=verify&token={token}#home",
                    user.email,
                )
            return Response({"detail": "如果邮箱对应的账号符合条件，邮件将发送至该邮箱。"})
        if action == "reset":
            uid, token = request.data.get("uid"), request.data.get("token")
            if (
                not isinstance(uid, (int, str))
                or not str(uid).isdigit()
                or not isinstance(token, str)
                or len(token) > 200
            ):
                raise ValidationError("重置链接无效。")
            uid = serializers.IntegerField(min_value=1, max_value=9223372036854775807).run_validation(uid)
            user = get_object_or_404(User, pk=uid, is_active=True)
            if not default_token_generator.check_token(user, token):
                raise ValidationError("重置链接无效或已过期。")
            password = serializers.CharField(max_length=256, trim_whitespace=False).run_validation(
                request.data.get("password")
            )
            validate_password(password, user)
            user.set_password(password)
            user.save(update_fields=["password"])
            return Response({"detail": "密码已更新，请重新登录。"})
        raise ValidationError("未知账号操作。")


class FavoritesView(CommunityAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        items = Favorite.objects.filter(user=request.user).select_related(
            "person", "relationship__person_a", "relationship__person_b"
        )
        if "targetType" in request.query_params:
            _, target = get_target(request.query_params)
            return Response({"saved": items.filter(**target).exists()})
        return Response(paginated(request, items, lambda x: {"id": x.pk, **target_data(x)}))

    def post(self, request):
        _, target = get_target(request.data)
        Favorite.objects.get_or_create(user=request.user, **target)
        return Response({"saved": True}, status=201)

    def delete(self, request):
        # 已撤下的档案仍允许用户取消收藏。
        if "id" in request.data:
            pk = serializers.IntegerField(min_value=1, max_value=9223372036854775807).run_validation(
                request.data["id"]
            )
            Favorite.objects.filter(user=request.user, pk=pk).delete()
        else:
            _, target = get_target(request.data)
            Favorite.objects.filter(user=request.user, **target).delete()
        return Response({"saved": False})


def comment_data(item, user):
    return {
        "id": item.pk,
        "body": item.body,
        "author": item.author.username,
        "createdAt": item.created_at.isoformat(),
        "isOwn": user.is_authenticated and item.author_id == user.pk,
    }


class CommentsView(CommunityAPIView):
    def get(self, request):
        _, target = get_target(request.query_params)
        items = Comment.objects.filter(**target, status="visible").select_related("author")
        return Response(paginated(request, items, lambda x: comment_data(x, request.user)))

    def post(self, request):
        _, target = get_target(request.data)
        body = serializers.CharField(max_length=3000).run_validation(request.data.get("body"))
        item = Comment.objects.create(author=request.user, body=body, **target)
        return Response(comment_data(item, request.user), status=201)


class CommentView(CommunityAPIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, pk):
        item = get_object_or_404(Comment, pk=pk, author=request.user)
        item.status = "deleted"
        item.save(update_fields=["status"])
        return Response(status=204)


class ReportView(CommunityAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        item = get_object_or_404(Comment, pk=pk, status="visible")
        get_target(
            {
                "targetType": "person" if item.person_id else "relationship",
                "targetId": str(item.person_id or item.relationship_id),
            }
        )
        reason = serializers.CharField(max_length=500).run_validation(request.data.get("reason"))
        _, created = Report.objects.get_or_create(
            comment=item, reporter=request.user, defaults={"reason": reason}
        )
        return Response(
            {"detail": "举报已提交，管理员会核查。" if created else "你已举报过这条评论。"},
            status=201 if created else 200,
        )


class SubmissionsView(CommunityAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        items = Submission.objects.filter(author=request.user).select_related(
            "person", "relationship__person_a", "relationship__person_b"
        )
        return Response(
            paginated(
                request,
                items,
                lambda x: {
                    "id": x.pk,
                    **target_data(x),
                    "body": x.body,
                    "status": x.status,
                    "reviewNote": x.review_note,
                    "createdAt": x.created_at.isoformat(),
                },
            )
        )

    def post(self, request):
        obj, target = get_target(request.data)
        body = serializers.CharField(max_length=6000).run_validation(request.data.get("body"))
        evidence = serializers.CharField(max_length=12000, allow_blank=True).run_validation(
            request.data.get("evidence", "")
        )
        item = Submission.objects.create(
            author=request.user, body=body, evidence_text=evidence, base_version=obj.version, **target
        )
        return Response({"id": item.pk, "detail": "补充已提交，审核结果可在“我的档案”查看。"}, status=201)


class HealthView(AtlasAPIView):
    permission_classes = [AllowAny]

    def get(self, request):
        from django.db import connection

        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return Response({"status": "ok"})
