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
  Query,
} from '@nestjs/common';

import {
  CurrentScope,
  CurrentUser,
  Permissions,
  Roles,
} from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { CommunityService } from './community.service';
import {
  CreateDiscussionDto,
  CreateGroupDto,
  UpdateGroupDto,
} from './dto/community.dto';

/**
 * Admin moderation of the Learning Community. The READ is open to the admin
 * audience (content reads are, §5.2.1); the DELETEs are writes gated by
 * `moderate_community`. Everything is org-scoped in the service — an admin
 * only ever sees and removes their own tenant's posts.
 */
@Controller('admin/community')
@Roles('admin')
export class AdminCommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly publicId: PublicIdService,
  ) {}

  @Get()
  async feed(
    @CurrentScope() scope: OrgScope,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.community.adminFeed(scope, {
      type,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── Groups + discussion creation. Static routes BEFORE ':postId'. ──

  /** Manage the org's groups (including archived), with counts. */
  @Get('groups')
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
