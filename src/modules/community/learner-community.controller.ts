import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { CommunityService } from './community.service';
import { CreateKudosDto, CreatePostDto, CreateReplyDto } from './dto/community.dto';

/**
 * The learner's Learning Community. Open to the learner audience (participating
 * is not an org-granted capability); the whole module is gated by the org's
 * `community_enabled` flag, checked in the service. `:postId` is the post's
 * public UUID (§10.34); replies are addressed by their integer id.
 */
@Controller('learner/community')
@Roles('learner')
export class LearnerCommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly publicId: PublicIdService,
  ) {}

  @Get()
  async feed(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Query('type') type?: string,
    @Query('hashtag') hashtag?: string,
    @Query('group') group?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const groupId = group
      ? await this.publicId.resolveIdOrThrow('community_groups', group)
      : undefined;
    return this.community.feed(scope, user, {
      type,
      hashtag,
      groupId,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  async create(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePostDto,
  ) {
    const groupId = dto.groupId
      ? await this.publicId.resolveIdOrThrow('community_groups', dto.groupId)
      : undefined;
    return this.community.createPost(scope, user, dto, groupId);
  }

  // ── Static routes, declared BEFORE ':postId' so they are not captured as a
  //    post id (Express matches in registration order). ──

  /** People search for the kudos picker. */
  @Get('people')
  async people(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.community.searchPeople(scope, user, q);
  }

  /** Hashtag autocomplete. */
  @Get('hashtags')
  async hashtags(@CurrentScope() scope: OrgScope, @Query('q') q?: string) {
    return this.community.hashtagSuggest(scope, q);
  }

  /** Trending hashtags. */
  @Get('hashtags/trending')
  async trending(@CurrentScope() scope: OrgScope) {
    return this.community.hashtagTrending(scope);
  }

  /** Groups the learner can browse and join. */
  @Get('groups')
  async groups(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.community.listGroups(scope, user);
  }

  @Post('groups/:groupId/join')
  @HttpCode(200)
  async joinGroup(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupIdParam: string,
  ) {
    const groupId = await this.publicId.resolveIdOrThrow('community_groups', groupIdParam);
    return this.community.joinGroup(scope, user, groupId);
  }

  @Delete('groups/:groupId/join')
  async leaveGroup(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupIdParam: string,
  ) {
    const groupId = await this.publicId.resolveIdOrThrow('community_groups', groupIdParam);
    return this.community.leaveGroup(scope, user, groupId);
  }

  /** Give kudos to a colleague. */
  @Post('kudos')
  @HttpCode(201)
  async giveKudos(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateKudosDto,
  ) {
    return this.community.giveKudos(scope, user, dto);
  }

  /** The caller's own kudos received — count + recent, for My Profile. */
  @Get('kudos/summary')
  async kudosSummary(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.community.kudosSummary(scope, user);
  }

  /** The Kudos leaderboard — most kudos received. */
  @Get('kudos/leaderboard')
  async kudosLeaderboard(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.community.kudosLeaderboard(scope, user);
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
    return this.community.detail(scope, user, postId);
  }

  @Delete(':postId')
  async remove(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.deleteOwnPost(scope, user, postId);
  }

  @Post(':postId/replies')
  @HttpCode(201)
  async reply(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
    @Body() dto: CreateReplyDto,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.reply(scope, user, postId, dto);
  }

  @Post(':postId/like')
  @HttpCode(200)
  async like(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.like(scope, user, postId);
  }

  @Delete(':postId/like')
  async unlike(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.unlike(scope, user, postId);
  }

  @Get(':postId/likes')
  async likes(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.postLikers(scope, user, postId);
  }

  @Delete('replies/:replyId')
  async removeReply(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('replyId', ParseIntPipe) replyId: number,
  ) {
    return this.community.deleteOwnReply(scope, user, replyId);
  }
}
