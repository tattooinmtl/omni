#include <iostream>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include <algorithm>
#include <format>

struct Record {
    std::string id;
    double value;
    bool valid;
};

class ComputeEngine {
public:
    explicit ComputeEngine(std::string_view engine_name)
        : m_engine_name(engine_name) {}

    ~ComputeEngine() = default;

    // Non-copyable, movable
    ComputeEngine(const ComputeEngine&) = delete;
    ComputeEngine& operator=(const ComputeEngine&) = delete;
    ComputeEngine(ComputeEngine&&) noexcept = default;
    ComputeEngine& operator=(ComputeEngine&&) noexcept = default;

    [[nodiscard]] double process_records(const std::vector<Record>& records) const {
        double total = 0.0;
        for (const auto& rec : records) {
            if (rec.valid) {
                total += rec.value;
            }
        }
        return total;
    }

    void print_status(double result) const {
        std::cout << std::format("[{}] Computed Total: {:.2f}\n", m_engine_name, result);
    }

private:
    std::string m_engine_name;
};

int main() {
    auto engine = std::make_unique<ComputeEngine>("ModernCppEngine20");

    std::vector<Record> dataset = {
        {"rec_01", 45.5, true},
        {"rec_02", 12.0, false},
        {"rec_03", 88.25, true}
    };

    double total_val = engine->process_records(dataset);
    engine->print_status(total_val);

    return 0;
}
