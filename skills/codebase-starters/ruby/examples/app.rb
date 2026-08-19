# frozen_string_literal: true

require 'json'
require 'time'

module Engine
  class UserRecord
    attr_reader :id, :email, :score, :active

    def initialize(id:, email:, score: 0.0, active: true)
      @id = id
      @email = email
      @score = score.to_f
      @active = active
    end

    def to_h
      {
        id: @id,
        email: @email,
        score: @score,
        active: @active
      }
    end
  end

  class RubyCoreProcessor
    attr_reader :engine_name

    def initialize(engine_name: 'Ruby3YjitEngine')
      @engine_name = engine_name
    end

    def process(user)
      raise ArgumentError, 'Expected UserRecord' unless user.is_a?(UserRecord)

      adjusted_score = user.score * 1.25
      {
        status: 'processed',
        engine: @engine_name,
        user_id: user.id,
        processed_score: adjusted_score.round(2),
        timestamp: Time.now.utc.iso8601
      }
    end
  end
end

if __FILE__ == $0
  puts "=== Ruby 3.3+ Production Starter ==="

  user = Engine::UserRecord.new(id: 'usr_3309', email: 'ruby.dev@example.com', score: 110.0)
  processor = Engine::RubyCoreProcessor.new

  result = processor.process(user)
  puts "Verified Output:\n#{JSON.pretty_generate(result)}"
end
