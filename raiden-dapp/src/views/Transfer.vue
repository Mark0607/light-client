<template>
  <v-form v-model="valid" autocomplete="off" class="transfer">
    <v-container fluid class="transfer__settings">
      <v-row
        align="center"
        justify="center"
        no-gutters
        class="transfer__actions"
      >
        <v-col cols="2" class="transfer__channels">
          <v-btn
            @click="navigateToChannels(token.address)"
            text
            class="transfer__channel-button"
          >
            {{ $t('transfer.channel-button') }}
          </v-btn>
        </v-col>
        <v-col cols="6" class="transfer__token-networks">
          <div class="transfer__token-networks__amount">
            {{
              $t('transfer.capacity-amount', {
                capacity: convertToUnits(capacity, token.decimals),
                token: token.symbol
              })
            }}
          </div>
          <div
            @click="showTokenNetworks = true"
            class="transfer__token-networks__dropdown"
          >
            <span>{{ token.name }}</span>
            <span>
              <down-arrow />
            </span>
          </div>
          <token-overlay
            :show="showTokenNetworks"
            @cancel="showTokenNetworks = false"
          />
        </v-col>
        <v-col cols="2" class="transfer__deposit">
          <v-dialog v-model="depositing" max-width="625">
            <template #activator="{ on }">
              <v-btn
                @click="depositing = true"
                v-on="on"
                text
                class="transfer__deposit-button"
              >
                {{ $t('transfer.deposit-button') }}
              </v-btn>
            </template>
            <v-card class="transfer__deposit-dialog">
              <channel-deposit
                @cancel="depositing = false"
                @confirm="deposit($event)"
                :token="token"
                identifier="0"
              ></channel-deposit>
            </v-card>
          </v-dialog>
        </v-col>
      </v-row>

      <v-row justify="center" align="center" class="transfer__recipient">
        <v-col cols="10">
          <address-input
            v-model="target"
            :exclude="[token.address, defaultAccount]"
            :block="blockedHubs"
          ></address-input>
        </v-col>
      </v-row>

      <v-row justify="center" align="center">
        <v-col cols="10">
          <amount-input
            v-model="amount"
            :token="token"
            :placeholder="$t('transfer.amount-placeholder')"
            :max="capacity"
            limit
          ></amount-input>
        </v-col>
      </v-row>

      <v-spacer></v-spacer>

      <action-button
        :enabled="valid"
        @click="proceedWithPathfinding()"
        :text="$t('general.buttons.continue')"
        class="transfer__action-button"
      ></action-button>

      <v-dialog v-model="serviceSelection" max-width="625">
        <v-card class="transfer__route-dialog">
          <pathfinding-services
            @cancel="serviceSelection = false"
            @confirm="findRoutes($event)"
          ></pathfinding-services>
        </v-card>
      </v-dialog>

      <v-dialog v-model="findingRoutes" max-width="625">
        <v-card class="transfer__route-dialog">
          <find-routes
            v-if="findingRoutes"
            @cancel="findingRoutes = false"
            @confirm="transfer($event)"
            :pfs="raidenPFS"
            :token="token"
            :amount="amount"
            :target="target"
          ></find-routes>
        </v-card>
      </v-dialog>
    </v-container>

    <stepper
      :display="loading"
      :steps="steps"
      :done-step="doneStep"
      :done="done"
    ></stepper>

    <error-screen
      :description="error"
      @dismiss="error = ''"
      :title="errorTitle"
      :button-label="$t('transfer.error.button')"
    ></error-screen>
  </v-form>
</template>

<script lang="ts">
import { Component, Mixins } from 'vue-property-decorator';
import AddressInput from '@/components/AddressInput.vue';
import AmountInput from '@/components/AmountInput.vue';
import { emptyDescription, StepDescription, Token, Route } from '@/model/types';
import { BalanceUtils } from '@/utils/balance-utils';
import Stepper from '@/components/Stepper.vue';
import ErrorScreen from '@/components/ErrorScreen.vue';
import Divider from '@/components/Divider.vue';
import TokenOverlay from '@/components/TokenOverlay.vue';
import TokenInformation from '@/components/TokenInformation.vue';
import ActionButton from '@/components/ActionButton.vue';
import ChannelDeposit from '@/components/ChannelDeposit.vue';
import FindRoutes from '@/components/FindRoutes.vue';
import DownArrow from '@/components/icons/DownArrow.vue';
import { BigNumber } from 'ethers/utils';
import { mapGetters, mapState } from 'vuex';
import { RaidenChannel, ChannelState, RaidenPFS } from 'raiden-ts';
import { Zero } from 'ethers/constants';
import AddressUtils from '@/utils/address-utils';
import NavigationMixin from '@/mixins/navigation-mixin';
import { getAddress, getAmount } from '@/utils/query-params';
import BlockieMixin from '@/mixins/blockie-mixin';
import PathfindingServices from '@/components/PathfindingServices.vue';

@Component({
  components: {
    PathfindingServices,
    ChannelDeposit,
    ActionButton,
    TokenInformation,
    Divider,
    AddressInput,
    AmountInput,
    Stepper,
    ErrorScreen,
    FindRoutes,
    DownArrow,
    TokenOverlay
  },
  computed: {
    ...mapState(['defaultAccount']),
    ...mapGetters(['channelWithBiggestCapacity', 'channels'])
  }
})
export default class Transfer extends Mixins(BlockieMixin, NavigationMixin) {
  showTokenNetworks: boolean = false;
  target: string = '';

  defaultAccount!: string;
  amount: string = '';

  valid: boolean = false;
  loading: boolean = false;
  done: boolean = false;
  depositing: boolean = false;
  findingRoutes: boolean = false;
  serviceSelection: boolean = false;
  raidenPFS: RaidenPFS | null = null;

  errorTitle: string = '';
  error: string = '';

  steps: StepDescription[] = [];
  doneStep: StepDescription = emptyDescription();

  convertToUnits = BalanceUtils.toUnits;

  channels!: (tokenAddress: string) => RaidenChannel[];

  channelWithBiggestCapacity!: (
    tokenAddress: string
  ) => RaidenChannel | undefined;

  get token(): Token {
    const { token: address } = this.$route.params;
    return this.$store.getters.token(address) || ({ address } as Token);
  }

  get blockedHubs(): string[] {
    return this.channels(this.token.address)
      .filter((channel: RaidenChannel) => channel.state !== ChannelState.open)
      .map((channel: RaidenChannel) => channel.partner as string);
  }

  get capacity(): BigNumber {
    const withBiggestCapacity = this.channelWithBiggestCapacity(
      this.token.address
    );
    if (withBiggestCapacity) {
      return withBiggestCapacity.capacity;
    }
    return Zero;
  }

  proceedWithPathfinding() {
    if (this.$raiden.noPfsSelected()) {
      this.serviceSelection = true;
    } else {
      this.findRoutes();
    }
  }

  findRoutes(raidenPFS: RaidenPFS | null = null) {
    this.serviceSelection = false;
    this.raidenPFS = raidenPFS;
    this.findingRoutes = true;
  }

  async created() {
    const { amount, target } = this.$route.query;

    this.amount = getAmount(amount);
    this.target = getAddress(target);

    const { token: address } = this.$route.params;

    if (!AddressUtils.checkAddressChecksum(address)) {
      this.navigateToHome();
      return;
    }

    await this.$raiden.fetchTokenData([address]);

    if (typeof this.token.decimals !== 'number') {
      this.navigateToHome();
    }
  }

  async deposit(amount: BigNumber) {
    this.steps = [
      (this.$t('transfer.steps.deposit') as any) as StepDescription
    ];
    this.doneStep = (this.$t(
      'transfer.steps.deposit-done'
    ) as any) as StepDescription;
    this.errorTitle = this.$t('transfer.error.deposit-title') as string;

    this.loading = true;

    try {
      await this.$raiden.deposit(
        this.token.address,
        this.channelWithBiggestCapacity(this.token.address)!.partner,
        amount
      );
      this.done = true;
      this.dismissProgress();
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
    this.depositing = false;
  }

  async transfer(route: Route) {
    this.steps = [
      (this.$t('transfer.steps.transfer') as any) as StepDescription
    ];
    this.doneStep = (this.$t('transfer.steps.done') as any) as StepDescription;
    this.errorTitle = this.$t('transfer.error.title') as string;
    this.findingRoutes = false;

    const { address, decimals } = this.token;
    const { path, fee } = route;

    try {
      this.loading = true;
      await this.$raiden.transfer(
        address,
        this.target,
        BalanceUtils.parse(this.amount, decimals!),
        [{ path, fee }]
      );

      this.done = true;
      this.dismissProgress();
    } catch (e) {
      this.loading = false;
      this.error = e.message;
    }
  }

  private dismissProgress() {
    setTimeout(() => {
      this.loading = false;
      this.done = false;
    }, 2000);
  }
}
</script>

<style lang="scss" scoped>
@import '../scss/colors';
.transfer {
  width: 100%;
  height: 100%;
}

.transfer__actions {
  margin-top: 10px;
}

.transfer__recipient {
  margin-top: 75px;
}

.transfer__recipient,
.transfer__amount {
  max-height: 150px;
}

.transfer__recipient__label {
  color: $secondary-color;
  font-size: 13px;
  font-weight: bold;
  letter-spacing: 3px;
  line-height: 15px;
  text-transform: uppercase;
}

.transfer__action-button {
  margin-bottom: 24px;
}

.transfer__channel-button,
.transfer__deposit-button {
  color: $primary-color;
  text-transform: none;
}

.transfer__token-networks__amount {
  color: $color-white;
  font-size: 24px;
  font-weight: bold;
  line-height: 19px;
  padding-left: 11px;
  margin-top: 10px;
  text-align: center;
}

.transfer__token-networks__dropdown {
  color: $primary-color;
  font-size: 16px;
  margin-top: 5px;
  cursor: pointer;
  text-align: center;

  &:hover {
    color: $secondary-color;

    & ::v-deep g {
      stroke: $secondary-color !important;
    }
  }

  & > span {
    display: inline-block;

    &:last-child {
      margin-left: 5px;
    }
  }
}
</style>