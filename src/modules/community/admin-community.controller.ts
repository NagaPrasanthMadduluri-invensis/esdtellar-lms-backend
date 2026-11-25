import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CrossPortal, CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { CommunityService } from './community.service';
import {
  CreateDiscussionDto,
  CreateGroupDto,
  CreateReplyDto,
  SetReactionDto,
  UpdateGroupDto,
} from './dto/community.dto';

/**
 * Admin moderation of, and participation in, the Learning Community. The
 * READS are open to the admin audience (content reads are, §5.2.1), and so is
 * TAKING PART (replying, reacting): a Learner needs no Permission to join in,
 * and neither does an Admin (owner request 2026-11-23). Removing other
 * people's content and curating Groups and Discussions are moderation, gated by
 * `moderate_community`. Everything is org-scoped in the service.
 */
@Controller('admin/community')
@Roles('admin')
export class AdminCommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly publicId: PublicIdService,
  ) {}

  @Get()
  @CrossPortal('moderate_community')
  async feed(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.community.adminFeed(scope, admin, {
      type,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── Groups + discussion creation. Static routes BEFORE ':postId'. ──

  /** Manage the org's groups (including archived), with counts. */
  @Get('groups')
  @CrossPortal('moderate_community')
  async groups(@CurrentScope() scope: OrgScope) {
    return this.community.adminListGroups(scope);
  }

  @Post('groups')
  @Permissions('moderate_community')
  @HttpCode(201)
  async createGroup(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateGroupDto,
  ) {
    return this.community.adminCreateGroup(scope, admin, dto);
  }

  @Patch('groups/:groupId')
  @Permissions('moderate_community')
  async updateGroup(
    @CurrentScope() scope: OrgScope,
    @Param('groupId', ParseIntPipe) groupId: number,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.community.adminUpdateGroup(scope, groupId, dto);
  }

  /** Create a discussion thread (the admin-curated type). */
  @Post('discussions')
  @Permissions('moderate_community')
  @HttpCode(201)
  async createDiscussion(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateDiscussionDto,
  ) {
    return this.community.adminCreateDiscussion(scope, admin, dto);
  }

  @Get(':postId')
  @CrossPortal('moderate_community')
  async detail(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.adminDetail(scope, user, postId);
  }

  /** Who reacted, with what and when: the full participant record. */
  @Get(':postId/reactions')
  @CrossPortal('moderate_community')
  async reactions(
    @CurrentScope() scope: OrgScope,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow('community_posts', postIdParam);
    return this.community.adminPostReactors(scope, postId);
  }

  /** Take part: reply to a post, or respond to a reply on it. */
  @Post(':postId/replies')
  @CrossPortal('moderate_community')
  @HttpCode(201)
  async reply(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
    @Param('postId') postIdParam: string,
    @Body() dto: CreateReplyDto,
  ) {
    const postId = await this.publicId.resolveIdOrThrow('community_posts', postIdParam);
    return this.community.reply(scope, admin, postId, dto);
  }

  /** Take part: set or change the admin's own quick reaction. */
  @Put(':postId/reaction')
  @CrossPortal('moderate_community')
  async react(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
    @Param('postId') postIdParam: string,
    @Body() dto: SetReactionDto,
  ) {
    const postId = await this.publicId.resolveIdOrThrow('community_posts', postIdParam);
    return this.community.react(scope, admin, postId, dto.kind);
  }

  @Delete(':postId/reaction')
  @CrossPortal('moderate_community')
  async unreact(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow('community_posts', postIdParam);
    return this.community.unreact(scope, admin, postId);
  }

  @Delete(':postId')
  @Permissions('moderate_community')
  async remove(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.adminDeletePost(scope, user, postId);
  }

  @Delete('replies/:replyId')
  @Permissions('moderate_community')
  async removeReply(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('replyId', ParseIntPipe) replyId: number,
  ) {
    return this.community.adminDeleteReply(scope, user, replyId);
  }
}
