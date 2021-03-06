(function() {

  'use_strict';

  return {
    SETUP_INFO: 'https://support.zendesk.com/entries/69791168-Setting-up-the-Time-Tracking-app',

    storage: {},

    requests: {
      fetchAudits: function() {
        return {
          url: helpers.fmt(
            '/api/v2/tickets/%@/audits.json?include=users',
            this.ticket().id()
          )
        };
      },
      fetchRequirements: function() {
        return {
          url: helpers.fmt(
            '/api/v2/apps/installations/%@/requirements.json',
            this.installationId()
          ),
          dataType: 'json'
        };
      },
      fetchTicketForms: function(url) {
        return {
          url: url || '/api/v2/ticket_forms.json'
        };
      }
    },

    events: {
      'app.created'             : 'onAppCreated',
      'app.activated'           : 'onAppActivated',
      'app.deactivated'         : 'onAppFocusOut',
      'app.willDestroy'         : 'onAppWillDestroy',
      'ticket.save'             : 'onTicketSave',
      'ticket.form.id.changed'  : 'onTicketFormChanged',
      'fetchAudits.done'        : 'onFetchAuditsDone',
      'fetchRequirements.done'  : 'onFetchRequirementsDone',
      'click .pause'            : 'onPauseClicked',
      'click .play'             : 'onPlayClicked',
      'click .reset'            : 'onResetClicked',
      'click .modal-save'       : 'onModalSaveClicked',
      'shown .modal'            : 'onModalShown',
      'hidden .modal'           : 'onModalHidden',
      'click .expand-bar'       : 'onTimelogsClicked'
    },

    /*
     *
     *  EVENT CALLBACKS
     *
     */
    onAppCreated: function() {
      if (this.installationId()) {
        this.ajax('fetchRequirements');
      } else {
        _.defer(this.initialize.bind(this));
        this.storage.totalTimeFieldId = parseInt(this.setting('total_time_field_id'), 10);
        this.storage.timeFieldId = parseInt(this.setting('time_field_id'), 10);
      }
    },

    onAppActivated: function(app) {
      if (!app.firstLoad) {
        this.onAppFocusIn();
      }
    },

    onAppWillDestroy: function() {
      clearInterval(this.timeLoopID);
    },

    onAppFocusOut: function() {
      if (this.setting('auto_pause_resume')) {
        this.autoPause();
      }
    },

    onAppFocusIn: function() {
      if (this.setting('auto_pause_resume') &&
         !this.manuallyPaused) {
        this.autoResume();
      }
    },

    onTicketFormChanged: function() {
      _.defer(this.hideFields.bind(this));
    },

    onTicketSave: function() {
      if (this.setting('time_submission')) {
        return this.promise(function(done, fail) {
          this.saveHookPromiseDone = done;
          this.saveHookPromiseFail = fail;

          this.renderTimeModal();
        }.bind(this));
      } else {
        this.updateTime(this.elapsedTime);

        return true;
      }
    },

    onFetchAuditsDone: function(data) {
      var status = "",
          timelogs = _.reduce(data.audits, function(memo, audit) {
            var newStatus = _.find(audit.events, function(event) {
              return event.field_name == 'status';
            }, this),
            event = _.find(audit.events, function(event) {
              return event.field_name == this.storage.timeFieldId;
            }, this);

            if (newStatus){
              status = newStatus.value;
            }

            if (event) {
              memo.push({
                time: this.TimeHelper.secondsToTimeString(parseInt(event.value, 0)),
                date: new Date(audit.created_at).toLocaleString(),
                status: status,
                localized_status: this.I18n.t(helpers.fmt('statuses.%@', status)),
                user: _.find(data.users, function(user) {
                  return user.id === audit.author_id;
                })
              });
            }

            return memo;
          }, [], this);

      this.renderTimelogs(timelogs.reverse());
    },

    onFetchRequirementsDone: function(data) {
      var totalTimeField = this._findWhere(data.requirements, {identifier: 'total_time_field'});
      var timeLastUpdateField = this._findWhere(data.requirements, {identifier: 'time_last_update_field'});
      this.storage.totalTimeFieldId = totalTimeField && totalTimeField.requirement_id;
      this.storage.timeFieldId = timeLastUpdateField && timeLastUpdateField.requirement_id;

      this.initialize();
    },

    onPauseClicked: function(e) {
      var $el = this.$(e.currentTarget);

      $el.find('i').addClass('active');
      this.$('.play i').removeClass('active');

      this.manuallyPaused = this.paused = true;
    },

    onPlayClicked: function(e) {
      var $el = this.$(e.currentTarget);

      $el.find('i').addClass('active');
      this.$('.pause i').removeClass('active');

      this.manuallyPaused = this.paused = false;
    },

    onResetClicked: function() {
      this.elapsedTime = 0;
      this.updateMainView(this.elapsedTime);
    },

    onTimelogsClicked: function() {
      this.$('.timelogs-container').slideToggle();
      this.$('.expand-bar').toggleClass('expanded');
    },

    onModalSaveClicked: function() {
      var timeString = this.$('.modal-time').val();

      try {
        this.updateTime(this.TimeHelper.timeStringToSeconds(timeString));
        this.saveHookPromiseIsDone = true; // Flag that saveHookPromiseDone is gonna be called after hiding the modal
        this.$('.modal').modal('hide');
        this.saveHookPromiseDone();
      } catch (e) {
        if (e.message == 'bad_time_format') {
          services.notify(this.I18n.t('errors.bad_time_format'), 'error');
        } else {
          throw e;
        }
      }
    },

    onModalShown: function() {
      var timeout = 15,
          $timeout = this.$('span.modal-timer'),
          $modal = this.$('.modal');

      this.modalTimeoutID = setInterval(function() {
        timeout -= 1;

        $timeout.html(timeout);

        if (timeout === 0) {
          $modal.modal('hide');
        }
      }.bind(this), 1000);
    },

    onModalHidden: function() {
      clearInterval(this.modalTimeoutID);

      if (!this.saveHookPromiseIsDone) {
        this.saveHookPromiseFail(this.I18n.t('errors.save_hook'));
      }
    },

    /*
     *
     * METHODS
     *
     */

    checkForms: (function() {
      var forms = [];

      function fetch(url) {
        this.ajax('fetchTicketForms', url).done(callback.bind(this));
      }

      function callback(data) {
        forms.push.apply(forms, data.ticket_forms);

        if (data.next_page) {
          fetch.call(this, data.next_page);
        } else {
          var requiredTicketFieldIds = [
                this.storage.timeFieldId,
                this.storage.totalTimeFieldId
              ];

          forms = _.filter(forms, function(form) {
            return form.active;
          });

          var valid = _.all(forms, function(form) {
            return _.intersection(form.ticket_field_ids, requiredTicketFieldIds).length === requiredTicketFieldIds.length;
          });

          if (!valid) {
            this.switchTo('setup_info', { link: this.SETUP_INFO });
            this.$('.expand-bar').remove();
            this.onAppWillDestroy();
          }
        }
      }

      return function() {
        if (!this.ticket().form().id()) { return; }

        fetch.call(this);
      };
    })(),

    initialize: function() {
      var displayTimelogs = this.ticket().id() && this.setting('display_timelogs');

      if (displayTimelogs) {
        this.ajax('fetchAudits');
      }

      this.hideFields();
      this.checkForms();

      this.timeLoopID = this.setTimeLoop();

      this.switchTo('main', {
        manualPauseResume: this.setting('manual_pause_resume'),
        displayReset: this.setting('reset'),
        displayTimelogs: displayTimelogs
      });
    },

    updateMainView: function(time) {
      this.$('.live-timer').html(this.TimeHelper.secondsToTimeString(time));
      this.$('.live-totaltimer').html(this.TimeHelper.secondsToTimeString(
        this.totalTime() + time
      ));
    },

    renderTimelogs: function(timelogs) {
      this.$('.timelogs-container')
        .html(this.renderTemplate('timelogs', {
          timelogs: timelogs
        }));

      this.$('tr').tooltip({ placement: 'left', html: true });
    },

    hideFields: function() {
      _.each([this.timeFieldLabel(), this.totalTimeFieldLabel()], function(f) {
        var field = this.ticketFields(f);

        if (field) {
          field.hide();
        }
      }, this);
    },

    /*
     * TIME RELATED
     */

    setTimeLoop: function() {
      this.elapsedTime = 0;

      return setInterval(function() {
        if (!this.paused) {
          // Update elapsed time by 1 second
          this.elapsedTime += 1;

          this.updateMainView(this.elapsedTime);
        }
      }.bind(this), 1000);
    },

    updateTime: function(time) {
      this.time(time);
      this.totalTime(this.totalTime() + time);
    },

    autoResume: function() {
      this.paused = false;
    },

    autoPause: function() {
      this.paused = true;
    },

    renderTimeModal: function() {
      this.$('.modal-time').val(this.TimeHelper.secondsToTimeString(this.elapsedTime));
      this.$('.modal').modal('show');
    },

    /*
     *
     * UTILS
     *
     */

    // CRUFT: Can be removed when using recent versions of Underscore.js

    // Returns a predicate for checking whether an object has a given set of `key:value` pairs.
    _matches: function(attrs) {
      return function(obj) {
        if (obj == null) return _.isEmpty(attrs);
        if (obj === attrs) return true;
        for (var key in attrs) if (attrs[key] !== obj[key]) return false;
        return true;
      };
    },

    // Convenience version of a common use case of `find`: getting the first object
    // containing specific `key:value` pairs.
    _findWhere: function(obj, attrs) {
      return _.find(obj, this._matches(attrs));
    },

    /*
     *
     * HELPERS
     *
     */

    time: function(time) {
      return this.getOrSetField(this.timeFieldLabel(), time);
    },

    totalTime: function(time) {
      return this.getOrSetField(this.totalTimeFieldLabel(), time);
    },

    totalTimeFieldLabel: function() {
      return this.buildFieldLabel(this.storage.totalTimeFieldId);
    },

    timeFieldLabel: function() {
      return this.buildFieldLabel(this.storage.timeFieldId);
    },

    buildFieldLabel: function(id) {
      return helpers.fmt('custom_field_%@', id);
    },

    getOrSetField: function(fieldLabel, value) {
      if (value) {
        return this.ticket().customField(fieldLabel, value);
      }

      return parseInt((this.ticket().customField(fieldLabel) || 0), 0);
    },

    TimeHelper: {
      secondsToTimeString: function(seconds) {
        var hours   = Math.floor(seconds / 3600),
            minutes = Math.floor((seconds - (hours * 3600)) / 60),
            secs    = seconds - (hours * 3600) - (minutes * 60);

        return helpers.fmt('%@:%@:%@',
                           this.addInsignificantZero(hours),
                           this.addInsignificantZero(minutes),
                           this.addInsignificantZero(secs));
      },

      timeStringToSeconds: function(timeString) {
        var re = /^([\d]{2}):([\d]{2}):([\d]{2})$/,
            result = re.exec(timeString);

        if (!result ||
            result.length != 4) {
          throw { message: 'bad_time_format' };
        } else {
          return parseInt(result[1], 10) * 3600 +
            parseInt(result[2], 10) * 60 +
            parseInt(result[3], 10);
        }
      },

      addInsignificantZero: function(n) {
        return ( n < 10 ? '0' : '') + n;
      }
    }
  };
}());
